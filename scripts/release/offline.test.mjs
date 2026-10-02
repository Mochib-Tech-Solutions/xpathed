import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startOfflineWorker } from "./offline.mjs";

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
  async function request(instruction, baseline = false) {
    const name = (++sequence).toString(16).padStart(32, "0");
    const input = { instruction, candidates: [{ id: "target" }] };
    await writeFile(
      join(output, "offline", `${name}.request.json`),
      JSON.stringify({ baseline, input, expected: "private-oracle-label" }),
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
