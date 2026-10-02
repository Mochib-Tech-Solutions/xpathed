import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startOfflineWorker } from "./offline.mjs";

test("polling failures remain observed until shutdown reports them", async () => {
  const root = await mkdtemp(join(tmpdir(), "xpathed-offline-poll-failure-"));
  await writeFile(join(root, "offline"), "not a directory");
  const stop = startOfflineWorker({ output: root }, async () =>
    assert.fail("Unexpected Docker call"),
  );
  try {
    await delay(50);
    await assert.rejects(stop(), { code: "ENOTDIR" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline worker sends only model input to pinned images and retains execution errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "xpathed-offline-worker-"));
  const bin = join(root, "bin"),
    output = join(root, "output"),
    log = join(root, "calls.jsonl");
  await mkdir(bin);
  await mkdir(join(output, "offline"), { recursive: true });
  await writeFile(log, "");
  await writeFile(
    join(bin, "docker"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2), input = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args,input,host:process.env.DOCKER_HOST,context:process.env.DOCKER_CONTEXT})+"\\n");
if (args.includes("--prepare-only")) console.log(JSON.stringify({prepared:true}));
else if (input.instruction === "malformed") console.log("invalid JSON");
else if (input.instruction === "provider failure") { console.log(JSON.stringify({outcome:"error",diagnostics:{code:"provider_timeout"}})); process.exitCode=1; }
else console.log(JSON.stringify({outcome:"found"}));
`,
    { mode: 0o700 },
  );
  const image = "sha256:" + "a".repeat(64),
    id = "b".repeat(64),
    baselineId = "c".repeat(64);
  const artifact = { images: [{}, { id: image }] };
  const state = {
    output,
    dockerHost: "unix:///test-only.sock",
    directory: root,
    project: "offline-test",
    service: "resolver",
    artifact,
    comparison: { artifact },
  };
  let wrongImage = false;
  const docker = async (args) => {
    if (args[0] === "ps") {
      assert.ok(args.includes("label=com.docker.compose.project=offline-test"));
      return args.includes("label=com.docker.compose.service=resolver-baseline") ? baselineId : id;
    }
    assert.equal(args[0], "inspect");
    return JSON.stringify([
      {
        Image: wrongImage ? "wrong-image" : image,
        Config: { Labels: { "com.docker.compose.project.working_dir": root } },
      },
    ]);
  };
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  const stop = startOfflineWorker(state, docker);
  let sequence = 0;
  async function request(instruction, baseline = false, workerId) {
    const name = (++sequence).toString(16).padStart(32, "0");
    const input = { instruction, candidates: [{ id: "target" }] };
    await writeFile(
      join(output, "offline", `${name}.request.json`),
      JSON.stringify({ baseline, input, workerId, expected: "private-oracle-label" }),
    );
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        return JSON.parse(await readFile(join(output, "offline", `${name}.response.json`), "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(25);
    }
    assert.fail("Offline worker did not write a response");
  }
  try {
    const result = await request("select target");
    assert.deepEqual(result.prepared, { prepared: true });
    assert.deepEqual(result.result, { outcome: "found" });
    assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
    const failed = await request("provider failure", true);
    assert.deepEqual(failed.result, {
      outcome: "error",
      diagnostics: { code: "provider_timeout" },
    });
    assert.deepEqual(failed.prepared, { prepared: true });
    assert.match((await request("malformed")).error, /JSON/);
    const before = await readFile(log, "utf8");
    assert.match((await request("select target", false, 16)).error, /Invalid offline request/);
    assert.equal(await readFile(log, "utf8"), before);
    wrongImage = true;
    assert.match((await request("select target")).error, /artifact mismatch/);
    assert.equal(await readFile(log, "utf8"), before);
    const calls = before.trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 6);
    assert.equal(before.includes("private-oracle-label"), false);
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      assert.deepEqual(call.args, [
        "exec",
        "-i",
        index >= 2 && index < 4 ? baselineId : id,
        "dotnet",
        "Resolver.dll",
        "--evaluate-offline",
        "/dev/stdin",
        ...(index % 2 === 0 ? ["--prepare-only"] : []),
      ]);
      assert.deepEqual(Object.keys(call.input), ["instruction", "candidates"]);
      assert.equal(call.host, state.dockerHost);
      assert.equal(call.context, "");
    }
  } finally {
    await stop();
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("parallel offline requests isolate routing, bound execution, drain and never replay IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "xpathed-offline-parallel-"));
  const directory = join(root, "offline"),
    bin = join(root, "bin"),
    log = join(root, "calls");
  await mkdir(directory);
  await mkdir(bin);
  await writeFile(log, "");
  await writeFile(
    join(bin, "docker"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2), input = JSON.parse(fs.readFileSync(0, "utf8"));
if (args.includes("--prepare-only")) console.log(JSON.stringify({prepared:true}));
else {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args,input})+"\\n");
  const timer = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(root)}+"/release-"+input.worker)) {
      clearInterval(timer); console.log(JSON.stringify({outcome:"found"}));
    }
  }, 10);
}
`,
    { mode: 0o700 },
  );
  const id = "b".repeat(64),
    image = "sha256:" + "a".repeat(64);
  const docker = async (args) =>
    args[0] === "ps"
      ? id
      : JSON.stringify([
          { Image: image, Config: { Labels: { "com.docker.compose.project.working_dir": root } } },
        ]);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  const stop = startOfflineWorker(
    {
      output: root,
      directory: root,
      project: "parallel",
      service: "resolver",
      artifact: { images: [{}, { id: image }] },
      concurrency: 2,
    },
    docker,
  );
  const name = (index) => (index + 1).toString(16).padStart(32, "0");
  const send = (index) =>
    writeFile(
      join(directory, `${name(index)}.request.json`),
      JSON.stringify({ baseline: false, workerId: index, input: { worker: index } }),
    );
  const calls = async () =>
    (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  async function until(condition) {
    for (let i = 0; i < 200; i++) {
      if (await condition()) return;
      await delay(25);
    }
    assert.fail("Timed out waiting for offline workers");
  }
  try {
    await Promise.all([0, 1, 2].map(send));
    await until(async () => (await calls()).length === 2);
    await delay(150);
    assert.equal((await calls()).length, 2, "third request must wait for capacity");
    await Promise.all([0, 1].map((i) => writeFile(join(root, `release-${i}`), "")));
    await until(async () => (await calls()).length === 3);
    await send(0);
    await delay(150);
    assert.equal((await calls()).length, 3, "recreated request ID must not replay");
    let drained = false;
    const closing = stop().then(() => {
      drained = true;
    });
    await delay(150);
    assert.equal(drained, false, "shutdown must await the active request");
    await writeFile(join(root, "release-2"), "");
    await closing;
    for (const call of await calls()) {
      assert.deepEqual(call.args.slice(0, 5), [
        "exec",
        "-i",
        "-e",
        `OpenRouter__ApiKey=evaluation-worker-${call.input.worker}`,
        id,
      ]);
      assert.equal(
        call.args.some((arg) => arg.includes("BaseUrl")),
        false,
      );
      assert.equal(
        JSON.parse(await readFile(join(directory, `${name(call.input.worker)}.response.json`)))
          .result.outcome,
        "found",
      );
    }
  } finally {
    await Promise.all([0, 1, 2].map((i) => writeFile(join(root, `release-${i}`), "")));
    await stop();
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});
