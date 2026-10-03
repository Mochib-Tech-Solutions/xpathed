import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectModelCases, runModelEvaluation } from "./model.mjs";
import { replay } from "./run.mjs";

const input = {
  instruction: "Click Save",
  candidates: [{ id: "c1", tag: "button", label: "Save" }],
};
const spec = {
  id: "model-save",
  family: "form",
  split: "test",
  category: "external-target",
  track: "offline-selection",
  dataset: "fixture",
  instruction: input.instruction,
  input,
  expected: {
    outcome: "found",
    actions: [{ step: 1, outcome: "found", target: { candidateId: "c1" } }],
  },
  review: {
    status: "reviewed",
    reviewer: "fixture-review",
    reviewedAt: "2026-10-03T00:00:00Z",
    providerSubmission: true,
    inputHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
  },
};

test("model selection requires reviewed unchanged inputs and rejects an empty filter", () => {
  assert.equal(selectModelCases(undefined, [spec]).length, 1);
  assert.throws(() => selectModelCases("missing", [spec]), /No matching/);
  assert.throws(
    () => selectModelCases(undefined, [{ ...spec, input: { ...input, instruction: "changed" } }]),
    /reviewed/,
  );
  assert.throws(
    () =>
      selectModelCases(undefined, [
        { ...spec, review: { ...spec.review, providerSubmission: false } },
      ]),
    /reviewed/,
  );
});

for (const invalidIdentity of [false, true])
  test(`model run retains failures, accounting and replay; invalid identity=${invalidIdentity}`, async (t) => {
    const output = await mkdtemp(join(tmpdir(), "model-evaluation-"));
    t.after(() => rm(output, { recursive: true, force: true }));
    t.mock.method(console, "log", () => {});
    const records = [];
    let stopped = false,
      processed = 0;
    const worker = (async () => {
      while (!stopped) {
        for (const file of await readdir(join(output, "offline")).catch(() => [])) {
          if (!file.endsWith(".request.json")) continue;
          const path = join(output, "offline", file);
          const request = JSON.parse(await readFile(path));
          assert.deepEqual(Object.keys(request).sort(), ["baseline", "input"]);
          assert.deepEqual(request.input, input);
          processed++;
          await writeFile(
            path.replace(".request.json", ".response.json"),
            JSON.stringify({
              elapsedMs: 10,
              prepared: {
                modelInput: JSON.stringify(input),
                prompt: "Select",
                schema: {},
                effective: { request: { model: "model", provider: { only: ["route"] } } },
              },
              result:
                processed === 1
                  ? { outcome: "error", diagnostics: { code: "provider_timeout" } }
                  : {
                      outcome: "found",
                      action: "click",
                      actions: [{ step: 1, action: "click", outcome: "found", candidateId: "c1" }],
                    },
            }),
          );
          await rm(path);
        }
        await delay(5);
      }
    })();
    try {
      const code = await runModelEvaluation(
        { output, repetitions: 1, concurrency: 1, seed: 1, timeoutMs: 1000 },
        [spec, { ...spec, id: "model-save-2" }],
        {
          profiles: [{ pricing: {} }],
          records,
          beginAttempt(id) {
            records.push({
              attemptId: id,
              forwarded: true,
              identityValid: !invalidIdentity,
              reportedUsd: null,
            });
          },
          async awaitIdle() {},
        },
      );
      assert.equal(code, 1);
      const summary = JSON.parse(await readFile(join(output, "summary.json")));
      assert.equal(summary.plannedTrials, 2);
      assert.equal(summary.completedTrials, invalidIdentity ? 1 : 2);
      assert.equal(processed, invalidIdentity ? 1 : 2);
      assert.equal(summary.firstAttempt.cost.reportedUsd.total, null);
      assert.equal((await replay(output)).passed, false);
    } finally {
      stopped = true;
      await worker;
    }
  });
