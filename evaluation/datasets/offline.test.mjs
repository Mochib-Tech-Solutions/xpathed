import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { executeOffline } from "./offline.mjs";

test("offline bridge sends only reviewed input, retains Resolver evidence and original errors", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "xpathed-offline-bridge-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const spec = {
    input: { instruction: "Click Save", candidates: [{ id: "n1", tag: "button", text: "Save" }] },
    expected: { actions: [{ target: { candidateId: "n1" } }] },
    review: { reviewer: "private reviewer" },
  };
  for (const failed of [false, true]) {
    const trial = { id: failed ? "failed" : "success" };
    const running = executeOffline(spec, trial, output, 1000, failed, failed ? 3 : undefined);
    const path = join(output, "offline", trial.id);
    let request;
    for (let i = 0; i < 100 && !request; i++) {
      request = await readFile(`${path}.request.json`, "utf8")
        .then(JSON.parse)
        .catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      if (!request) await delay(10);
    }
    assert.deepEqual(request, {
      baseline: failed,
      input: spec.input,
      ...(failed ? { workerId: 3 } : {}),
    });
    const result = {
      outcome: "found",
      configurationId: "configuration",
      actions: [{ step: 1, action: "click", outcome: "found", candidateId: "n1" }],
    };
    const response = failed
      ? { error: "Resolver artifact mismatch" }
      : {
          result,
          elapsedMs: 123,
          prepared: {
            modelInput: JSON.stringify(spec.input),
            prompt: "Select a target",
            schema: {},
            promptVersion: "7",
            effective: {
              strategy: "single",
              request: { model: "model", provider: { only: ["provider"] } },
            },
          },
        };
    await writeFile(`${path}.response.json`, JSON.stringify(response));
    await running;
    if (failed) {
      assert.equal(trial.error.code, "offline_execution_failed");
      assert.equal(trial.error.message, "Resolver artifact mismatch");
      assert.equal(trial.result, undefined);
    } else {
      assert.equal(trial.result.actions[0].target.candidateId, "n1");
      assert.equal(trial.result.summary, undefined);
      assert.equal(trial.evidence.modelInput, JSON.stringify(spec.input));
      assert.deepEqual(trial.observation.modelInputCoverage, { expected: 1, found: 1 });
      assert.equal(trial.elapsedMs, 123);
    }
  }
});

test("offline bridge rejects invalid worker routing before writing requests", async () => {
  for (const workerId of [-1, 16, 1.5, "1", null])
    await assert.rejects(
      executeOffline({}, {}, "/unused", 1000, false, workerId),
      /worker identity/,
    );
});
