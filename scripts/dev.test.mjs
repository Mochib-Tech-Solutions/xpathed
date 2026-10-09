import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { browserExecutable, developmentConfig, loadEnvironment } from "./native.mjs";

const exited = (child) => child.exitCode !== null || child.signalCode !== null;
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xpathed-dev-")));
  const children = [];
  const digest = createHash("sha256").update(root).digest("hex");
  const port = 30000 + (Number.parseInt(digest.slice(0, 8), 16) % 30000);
  let base;
  for (let candidate = 16000; candidate < 25000; candidate += 4) {
    const reservations = [];
    try {
      for (let index = 0; index < 4; index++) {
        const server = createServer();
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(candidate + index, "127.0.0.1", resolve);
        });
        reservations.push(server);
      }
      base = candidate;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    } finally {
      await Promise.all(
        reservations.map((server) => new Promise((resolve) => server.close(resolve))),
      );
    }
    if (base) break;
  }
  assert.ok(base);
  t.after(async () => {
    for (const child of children) if (!exited(child)) child.kill("SIGTERM");
    for (let attempt = 0; attempt < 100 && children.some((child) => !exited(child)); attempt++)
      await delay(100);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "bin"));
  for (const name of ["dev.mjs", "native.mjs", "service-process.mjs"])
    await cp(new URL(name, import.meta.url), join(root, "scripts", name));
  const envFile = `OPENROUTER_API_KEY=keep-this\nOPENROUTER_EVAL_API_KEY=eval-private\nXPATHED_PORT=${base}\nBROWSER_EXECUTABLE_PATH=${process.execPath}\n`;
  await writeFile(join(root, ".env"), envFile);
  await writeFile(join(root, "scripts/setup.sh"), "#!/bin/sh\nprintf 'setup\\n' >> events\n");
  const executable = String.raw`#!${process.execPath}
const fs = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(2);
const project = args.find(a => a.endsWith('.csproj'));
const name = project ? project.split('/')[1].toLowerCase() : 'web';
const port = project ? Number(new URL(process.env.ASPNETCORE_URLS).port) : Number(args[args.indexOf('--port') + 1]);
fs.appendFileSync('events', 'start ' + name + ' ' + JSON.stringify(args) + '\n');
if (process.env.TEST_FAIL_SERVICE === name) process.exit(7);
const server = http.createServer((req, res) => res.end('healthy'));
server.listen(port, '127.0.0.1', () => fs.appendFileSync('events', 'ready ' + name + '\n'));
if (process.env.TEST_PLUGIN_CHILD) {
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio:'ignore' });
  fs.appendFileSync('child-pids', child.pid + '\n');
}
process.on('SIGTERM', () => server.close(() => { fs.appendFileSync('events', 'stop ' + name + '\n'); process.exit(0); }));
`;
  for (const name of ["dotnet", "pnpm"])
    await writeFile(join(root, "bin", name), executable, { mode: 0o755 });
  const start = (extraEnv = {}, args = []) => {
    const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, ...extraEnv };
    delete env.XPATHED_ENV_FILE;
    delete env.XPATHED_PORT;
    delete env.BROWSER_EXECUTABLE_PATH;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [join(root, "scripts/dev.mjs"), ...args], {
      cwd: root,
      env,
      stdio: "pipe",
    });
    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.output = () => output;
    return child;
  };
  async function waitFor(check) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await check()) return;
      await delay(50);
    }
    assert.fail(children.map((child) => child.output()).join("\n"));
  }
  const events = () => readFile(join(root, "events"), "utf8").catch(() => "");
  const ready = (child) => waitFor(() => child.output().includes("workspace ready"));
  return { root, envFile, start, events, waitFor, ready, port, digest, base };
}

test("native dev replaces only its previous owner and preserves configuration", async (t) => {
  const { root, envFile, start, events, waitFor, ready } = await fixture(t);
  const first = start();
  await ready(first);
  const second = start();
  await ready(second);
  await waitFor(() => exited(first));
  assert.equal(second.exitCode, null);
  const stop = start({}, ["--stop"]);
  await waitFor(() => exited(second) && exited(stop));
  assert.equal(stop.exitCode, 0);
  assert.equal(await readFile(join(root, ".env"), "utf8"), envFile);
  assert.doesNotMatch(first.output() + second.output(), /keep-this|eval-private/);
  const log = await events();
  assert.ok(log.indexOf("ready browser") < log.indexOf("start resolver"));
  assert.ok(log.indexOf("ready resolver") < log.indexOf("start clientapi"));
  assert.ok(log.indexOf("ready clientapi") < log.indexOf("start web"));
  assert.ok(log.indexOf("stop web") < log.lastIndexOf("start browser"));
  assert.match(log, /--artifacts-path/);
  assert.doesNotMatch(log, /docker|compose/);
});

test("concurrent native dev invocations leave one complete owner", async (t) => {
  const { start, waitFor, ready } = await fixture(t);
  const first = start();
  await ready(first);
  const challengers = [start(), start()];
  await waitFor(() => exited(first) && challengers.filter((child) => !exited(child)).length === 1);
  const winner = challengers.find((child) => !exited(child));
  await ready(winner);
  winner.kill("SIGTERM");
  await waitFor(() => exited(winner));
  assert.equal(winner.exitCode, 0);
});

test("a killed launcher releases owned service groups before its replacement starts", async (t) => {
  const { root, start, waitFor, ready } = await fixture(t);
  const first = start({ TEST_PLUGIN_CHILD: "1" });
  await ready(first);
  const pids = (await readFile(join(root, "child-pids"), "utf8")).trim().split("\n").map(Number);
  first.kill("SIGKILL");
  await waitFor(() => exited(first));
  const second = start();
  await ready(second);
  await waitFor(() =>
    pids.every((pid) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    }),
  );
  second.kill("SIGTERM");
  await waitFor(() => exited(second));
});

test("startup failure stops earlier services and never launches later services", async (t) => {
  const { start, events, waitFor } = await fixture(t);
  const current = start({ TEST_FAIL_SERVICE: "resolver" });
  await waitFor(() => exited(current));
  assert.equal(current.exitCode, 1);
  assert.match(await events(), /stop browser/);
  assert.doesNotMatch(await events(), /start clientapi|start web/);
});

test("an occupied application port is never stopped", async (t) => {
  const { base, start, events, waitFor } = await fixture(t);
  const foreign = createServer();
  await new Promise((resolve) => foreign.listen(base + 1, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => foreign.close(resolve)));
  const current = start();
  await waitFor(() => exited(current));
  assert.equal(current.exitCode, 1);
  assert.match(current.output(), /occupied/);
  assert.doesNotMatch(await events(), /start /);
  assert.equal(foreign.listening, true);
});

for (const method of ["end", "resetAndDestroy", "wrongIdentity"])
  test(`foreign control listener ${method} never authorizes service startup or shutdown`, async (t) => {
    const { start, events, waitFor, port } = await fixture(t);
    const foreign = createServer((socket) =>
      method === "wrongIdentity" ? socket.end("another-checkout\n") : socket[method](),
    );
    await new Promise((resolve) => foreign.listen(port, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => foreign.close(resolve)));
    const current = start();
    await waitFor(() => exited(current));
    assert.equal(current.exitCode, 1);
    assert.match(current.output(), /occupied by another process|ECONNRESET/);
    assert.equal(await events(), "");
  });

test("configuration maps isolated loopback services and only Resolver receives the provider key", async () => {
  const config = developmentConfig("/checkout", {
    XPATHED_PORT: "12000",
    OPENROUTER_API_KEY: "private",
    OPENROUTER_EVAL_API_KEY: "evaluation-private",
  });
  assert.deepEqual(config.ports, [12000, 12001, 12002, 12003]);
  const [browser, resolver, client, web] = config.services;
  assert.equal(
    browser.env.ViewerOrigins,
    "http://127.0.0.1:12000,http://localhost:12000,http://127.0.0.1:12001",
  );
  assert.equal(resolver.env.OpenRouter__ApiKey, "private");
  assert.equal(client.env.ResolverUrl, "http://127.0.0.1:12002");
  assert.equal(web.env.XPATHED_URL, "http://127.0.0.1:12003");
  assert.equal(web.env.XPATHED_BROWSER_URL, "http://127.0.0.1:12001");
  for (const service of [browser, client, web])
    assert.doesNotMatch(JSON.stringify(service), /private/);
  assert.doesNotMatch(JSON.stringify(resolver), /evaluation-private/);
  assert.equal(new Set(config.services.slice(0, 3).map((service) => service.args[5])).size, 3);
  for (const value of ["0", "-1", "65533", "x", "1234.5"])
    assert.throws(
      () => developmentConfig("/checkout", { XPATHED_PORT: value }),
      /four consecutive ports/,
    );
});

test("native environment overrides files without rewriting them and validates explicit browsers", async (t) => {
  const { root, envFile } = await fixture(t);
  const env = await loadEnvironment(root, { OPENROUTER_API_KEY: "override" });
  assert.equal(env.OPENROUTER_API_KEY, "override");
  assert.equal(env.OPENROUTER_EVAL_API_KEY, "eval-private");
  assert.equal(await readFile(join(root, ".env"), "utf8"), envFile);
  assert.equal(
    await browserExecutable({ BROWSER_EXECUTABLE_PATH: process.execPath }),
    process.execPath,
  );
  await assert.rejects(
    browserExecutable({ BROWSER_EXECUTABLE_PATH: join(root, "missing") }),
    /installed executable/,
  );
  await assert.rejects(browserExecutable({}, "win32"), /macOS and Linux/);
});
