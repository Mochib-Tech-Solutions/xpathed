import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const root = await realpath(new URL("..", import.meta.url));
const project = process.env.COMPOSE_PROJECT_NAME || "xpathed";
const env = { ...process.env, COMPOSE_PROJECT_NAME: project };
const digest = createHash("sha256").update(`${root}\0${project}`).digest("hex");
const identity = `xpathed-dev-v1:${digest}`;
// ponytail: a hashed loopback port; collisions fail safely instead of replacing another project.
const port = 30000 + (Number.parseInt(digest.slice(0, 8), 16) % 30000);
let stopping = false;
let child;
let cleanupAllowed = false;
const clients = new Set();

function stop() {
  if (stopping) return;
  stopping = true;
  if (child) {
    try {
      // Docker invokes Compose as a plugin; stop only this owned process group.
      process.kill(-child.pid, "SIGINT");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

function run(command, args, capture = false) {
  return new Promise((resolve, reject) => {
    const startedStopping = stopping;
    child = spawn(command, args, {
      cwd: root,
      env,
      detached: true,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    const current = child;
    let output = "";
    current.stdout?.on("data", (chunk) => (output += chunk));
    current.once("error", reject);
    current.once("exit", (code, signal) => {
      if (child === current) child = undefined;
      if (!startedStopping && stopping)
        reject(new DOMException("Dev startup was interrupted.", "AbortError"));
      else if (code === 0) resolve(output);
      else reject(new Error(`${command} exited with ${code ?? signal}.`));
    });
  });
}

async function requireOwnedProject() {
  const ids = (
    await run(
      "docker",
      ["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`],
      true,
    )
  )
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (!ids.length) return;
  const owners = await run(
    "docker",
    [
      "inspect",
      "--format",
      '{{index .Config.Labels "com.docker.compose.project.working_dir"}}',
      ...ids,
    ],
    true,
  );
  for (const owner of owners.trim().split("\n")) {
    if ((await realpath(owner).catch(() => null)) !== root)
      throw new Error(
        `Compose project ${project} belongs to another checkout. Choose a different COMPOSE_PROJECT_NAME.`,
      );
  }
}

const server = createServer((socket) => {
  clients.add(socket);
  socket.on("error", () => socket.destroy());
  socket.on("close", () => clients.delete(socket));
  socket.write(`${identity}\n`);
  socket.setTimeout(60000, () => socket.destroy());
  let input = "";
  socket.on("data", (chunk) => {
    input += chunk;
    if (input.length > 128) socket.destroy();
    else if (input === `${identity}\n`) stop();
  });
});

async function replaceOwner() {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let input = "";
    let matched = false;
    socket.setTimeout(60000, () =>
      socket.destroy(new Error("The previous dev runner did not stop in time.")),
    );
    socket.on("error", (error) =>
      error.code === "ECONNREFUSED" || (matched && error.code === "ECONNRESET")
        ? resolve()
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
    socket.on("close", () => {
      if (matched) resolve();
      else reject(new Error("The dev control port is occupied by another process."));
    });
  });
}

try {
  while (!stopping) {
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      console.log("Replacing the existing dev runner for this checkout…");
      await replaceOwner();
      await delay(50);
    }
  }
  if (!stopping) await run("scripts/setup.sh", []);
  if (!stopping) {
    await requireOwnedProject();
    cleanupAllowed = true;
    await run("docker/compose.sh", ["--dev", "down"]);
  }
  if (!stopping) await run("docker/compose.sh", ["--dev", "up", "--build", "--watch"]);
} catch (error) {
  if (error.name !== "AbortError") {
    console.error(error.message);
    process.exitCode = 1;
  }
} finally {
  stopping = true;
  if (cleanupAllowed) {
    try {
      await requireOwnedProject();
      await run("docker/compose.sh", ["--dev", "down"]);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
  for (const socket of clients) socket.end();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}
