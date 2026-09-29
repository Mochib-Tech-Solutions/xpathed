import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const stopping = new AbortController();
const children = new Set();
const exits = [];
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => stopping.abort());
}

function start(command, args, environment = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...environment },
  });
  children.add(child);
  const exited = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code) => {
      children.delete(child);
      resolve({ code });
    });
  });
  exits.push(exited);
  return { child, exited, command };
}

async function run(command, args) {
  const result = await start(command, args).exited;
  stopping.signal.throwIfAborted();
  if (result.error) throw result.error;
  if (result.code !== 0) throw new Error(`${command} failed (${result.code}).`);
}

async function ready(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    stopping.signal.throwIfAborted();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(1000)]),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      stopping.signal.throwIfAborted();
    }
    await delay(250, undefined, { signal: stopping.signal });
  }
  throw new Error(`Service did not become ready: ${url}`);
}

function stopChildren(signal) {
  for (const child of children) {
    if (!child.pid) continue;
    try {
      child.kill(signal);
    } catch (error) {
      if (error.code !== "ESRCH") console.error(error.message);
    }
  }
}
let stopTimeout;
stopping.signal.addEventListener(
  "abort",
  () => {
    stopChildren("SIGTERM");
    stopTimeout = setTimeout(() => stopChildren("SIGKILL"), 5000);
  },
  { once: true },
);

try {
  if (!process.env.POSTGRES_PASSWORD) throw new Error("Run npm run setup first.");
  await run("docker", [
    "compose",
    "-f",
    "compose.yaml",
    "-f",
    "compose.dev.yaml",
    "up",
    "--build",
    "--wait",
    "browser",
    "db",
  ]);
  await run("dotnet", ["build", "Xpathed.slnx", "--no-restore"]);
  await ready("http://127.0.0.1:5082/health");
  const environment = {
    ASPNETCORE_ENVIRONMENT: "Development",
    BrowserUrl: "http://127.0.0.1:5082",
    ResolverUrl: "http://127.0.0.1:5081",
    ConnectionStrings__Database: `Host=127.0.0.1;Port=55432;Database=xpathed;Username=xpathed;Password="${process.env.POSTGRES_PASSWORD.replaceAll('"', '""')}"`,
  };
  const servers = [
    start(
      "dotnet",
      ["src/Resolver/bin/Debug/net10.0/Resolver.dll", "--urls", "http://127.0.0.1:5081"],
      environment,
    ),
    start(
      "dotnet",
      ["src/ClientApi/bin/Debug/net10.0/ClientApi.dll", "--urls", "http://127.0.0.1:5080"],
      environment,
    ),
    start(
      process.execPath,
      ["src/Web/node_modules/vite/bin/vite.js", "src/Web", "--config", "src/Web/vite.config.js"],
      {
        XPATHED_URL: "http://127.0.0.1:5080",
        XPATHED_BROWSER_URL: "http://127.0.0.1:5082",
      },
    ),
  ];
  const serverExit = Promise.race(
    servers.map(async ({ command, exited }) => {
      const result = await exited;
      if (!stopping.signal.aborted)
        throw result.error ?? new Error(`${command} stopped (${result.code}).`);
    }),
  );
  await Promise.race([
    Promise.all([
      ready("http://127.0.0.1:5080/health"),
      ready("http://127.0.0.1:5081/health"),
      ready("http://127.0.0.1:5173"),
    ]),
    serverExit,
  ]);
  if (!stopping.signal.aborted)
    console.log(
      "xpathed: http://127.0.0.1:5173 — Ctrl+C stops local services. Docker data is kept.",
    );
  await serverExit;
} catch (error) {
  if (!stopping.signal.aborted) {
    console.error(error.message);
    process.exitCode = 1;
  }
} finally {
  stopping.abort();
  await Promise.all(exits);
  clearTimeout(stopTimeout);
}
