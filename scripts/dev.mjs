import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  browserExecutable,
  developmentConfig,
  loadEnvironment,
  ManagedProcesses,
  waitForHealth,
} from "./native.mjs";

const root = await realpath(new URL("..", import.meta.url));
const digest = createHash("sha256").update(root).digest("hex");
const identity = `xpathed-native-dev:${digest}`;
// A collision fails safely; no PID file can authorize stopping another checkout.
const controlPort = 30000 + (Number.parseInt(digest.slice(0, 8), 16) % 30000);
const abort = new AbortController();
const clients = new Set();
let failure;
const stop = (error) => {
  if (abort.signal.aborted) return;
  if (error instanceof Error) failure = error;
  abort.abort();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const processes = new ManagedProcesses(root, stop);
const server = createServer((socket) => {
  clients.add(socket);
  socket.on("error", () => socket.destroy());
  socket.on("close", () => clients.delete(socket));
  socket.write(`${identity}\n`);
  socket.setTimeout(15000, () => socket.destroy());
  let input = "";
  socket.on("data", (chunk) => {
    input += chunk;
    if (input.length > 128) socket.destroy();
    else if (input === `${identity}\n`) stop();
  });
});

async function replaceOwner() {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: controlPort });
    let input = "";
    let matched = false;
    socket.setTimeout(15000, () =>
      socket.destroy(new Error("The previous dev runner did not stop in time.")),
    );
    socket.on("error", (error) =>
      error.code === "ECONNREFUSED" || (matched && error.code === "ECONNRESET")
        ? resolve(false)
        : reject(error),
    );
    socket.on("data", (chunk) => {
      input += chunk;
      if (!matched && input.includes("\n")) {
        if (input.split("\n")[0] !== identity) {
          socket.destroy();
          reject(new Error("The dev control port is occupied by another process."));
          return;
        }
        matched = true;
        socket.write(`${identity}\n`);
      }
      if (input.length > 256) socket.destroy(new Error("Invalid dev control response."));
    });
    socket.on("close", () =>
      matched
        ? resolve(true)
        : reject(new Error("The dev control port is occupied by another process.")),
    );
    const cancel = () => socket.destroy(abort.signal.reason);
    abort.signal.addEventListener("abort", cancel, { once: true });
    socket.on("close", () => abort.signal.removeEventListener("abort", cancel));
  });
}

function listen(listener, port) {
  return new Promise((resolve, reject) => {
    const failed = (error) => {
      listener.off("listening", ready);
      reject(error);
    };
    const ready = () => {
      listener.off("error", failed);
      resolve();
    };
    listener.once("error", failed);
    listener.once("listening", ready);
    listener.listen(port, "127.0.0.1");
  });
}
async function checkPorts(ports) {
  if (ports.includes(controlPort))
    throw new Error(
      "XPATHED_PORT overlaps this checkout's control port; choose another base port.",
    );
  for (const port of ports) {
    const deadline = Date.now() + 6000;
    while (true) {
      abort.signal.throwIfAborted();
      const probe = createServer();
      try {
        await listen(probe, port);
        await new Promise((resolve) => probe.close(resolve));
        break;
      } catch (error) {
        if (error.code !== "EADDRINUSE") throw error;
        if (Date.now() >= deadline)
          throw new Error(
            `Port ${port} is occupied. Set XPATHED_PORT to four free consecutive ports.`,
          );
        await delay(100, undefined, { signal: abort.signal });
      }
    }
  }
}

try {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--stop"))
    throw new Error("Use pnpm dev or pnpm dev:stop.");
  if (process.argv[2] === "--stop") {
    const stopped = await replaceOwner();
    console.log(
      stopped
        ? "Development services stopped."
        : "No development runner is active for this checkout.",
    );
  } else {
    while (!abort.signal.aborted) {
      try {
        await listen(server, controlPort);
        break;
      } catch (error) {
        if (error.code !== "EADDRINUSE") throw error;
        console.log("Replacing the existing dev runner for this checkout…");
        await replaceOwner();
        await delay(50, undefined, { signal: abort.signal });
      }
    }
    abort.signal.throwIfAborted();
    await promisify(execFile)("sh", ["scripts/setup.sh"], { cwd: root, signal: abort.signal });
    const env = await loadEnvironment(root);
    env.BROWSER_EXECUTABLE_PATH = await browserExecutable(env);
    const config = developmentConfig(root, env);
    await checkPorts(config.ports);
    for (const service of config.services) {
      abort.signal.throwIfAborted();
      console.log(`Starting ${service.name}…`);
      processes.start(service);
      await waitForHealth(service.health, abort.signal);
    }
    console.log(`Development workspace ready: ${config.urls.web}`);
    await new Promise((resolve) => {
      if (abort.signal.aborted) resolve();
      else abort.signal.addEventListener("abort", resolve, { once: true });
    });
  }
} catch (error) {
  if (!abort.signal.aborted) failure = error;
} finally {
  stop();
  await processes.stop();
  for (const socket of clients) socket.end();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  if (failure) {
    console.error(failure.message);
    process.exitCode = 1;
  }
}
