import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("native supervisor tolerates denied liveness probes while awaiting owned process cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "xpathed-supervisor-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hook = join(directory, "deny-once.mjs");
  await writeFile(
    hook,
    `const kill=process.kill;let denied=false;process.kill=function(pid,signal){if(signal===0&&!denied){denied=true;throw Object.assign(new Error('Liveness permission denied'),{code:'EPERM'});}return kill.call(process,pid,signal);};`,
  );
  const supervisor = fork(new URL("./service-process.mjs", import.meta.url), [], {
    execArgv: ["--import", pathToFileURL(hook).href],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  supervisor.stderr.on("data", (chunk) => (stderr += chunk));
  t.after(() => {
    if (supervisor.connected) supervisor.send("stop");
  });
  const ready = once(supervisor.stdout, "data", { signal: AbortSignal.timeout(10000) });
  supervisor.send({
    command: process.execPath,
    args: [
      "-e",
      "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),50));setInterval(()=>{},1000);console.log(process.pid)",
    ],
  });
  const [output] = await ready;
  const childPid = Number(String(output).trim());
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  const exited = once(supervisor, "exit", { signal: AbortSignal.timeout(10000) });
  supervisor.send("stop");
  const [code, signal] = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null, stderr);
  assert.equal(stderr, "");
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});
