// An IPC supervisor also cleans up the service group when its launcher crashes.
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

let child;
let stopping;
function signalGroup(signal) {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (signal === 0 && error.code === "EPERM") return true;
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}
function stop(code = 0) {
  stopping ??= (async () => {
    signalGroup("SIGTERM");
    const deadline = Date.now() + 5000;
    while (signalGroup(0) && Date.now() < deadline) await delay(25);
    signalGroup("SIGKILL");
    process.exit(code);
  })();
  return stopping;
}
process.on("disconnect", () => stop());
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
process.on("message", (message) => {
  if (message === "stop") {
    void stop();
    return;
  }
  if (child || stopping) return;
  child = spawn(message.command, message.args, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.once("error", () => {
    console.error("Service executable could not start.");
    void stop(1);
  });
  child.once("exit", (code) => {
    if (!stopping) void stop(code ?? 1);
  });
});
