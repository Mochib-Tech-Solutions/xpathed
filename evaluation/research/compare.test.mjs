import assert from "node:assert/strict";
import test from "node:test";
import { arms, assertParity, selectCases, summarize } from "./compare.mjs";

test("comparison uses the shared current cases and explicit plural labels", () => {
  const cases = selectCases();
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  assert.ok(cases.every((c) => c.contractVersion === "4" && !c.mutation && !c.provider.fault));
  assert.equal(selectCases("basic-save")[0].cardinality, "singleton");
  assert.equal(selectCases("plural-visible-scope-v4")[0].cardinality, "all");
  assert.throws(() => selectCases("missing"));
});

test("summary keeps missing attempts in category denominators and exposes regressions", () => {
  const cases = [{ id: "a" }, { id: "b" }];
  const manifest = { mode: "live", cases, groups: { a: "scope", b: "state" } };
  const trials = arms.flatMap((arm) =>
    cases.map((c) => ({
      arm,
      caseId: c.id,
      grade: { passed: arm === "basic" ? c.id === "a" : c.id === "b", metrics: {} },
      provider: [{ forwarded: true, reportedUsd: null }],
    })),
  );
  const report = summarize(manifest, trials);
  assert.deepEqual(report.changes, { gained: ["b"], lost: ["a"] });
  assert.equal(report.complete, true);
  const partial = summarize(manifest, trials.slice(0, -1));
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.categories.state.stagehand, { total: 1, passed: 0 });
  assert.equal(partial.arms.stagehand.unreportedCharges, 1);
});

test("parity rejects any changed browser observation", () => {
  const baseline = {
    viewport: { width: 1279, height: 799 },
    userAgent: "chromium",
    language: "en-US",
    languages: ["en-US", "en"],
    timeZone: "UTC",
    initialState: {},
    documentChecksum: "abc",
  };
  assert.doesNotThrow(() => assertParity(baseline, structuredClone(baseline)));
  for (const key of Object.keys(baseline))
    assert.throws(() => assertParity(baseline, { ...baseline, [key]: null }), new RegExp(key));
});

test("every planned case and arm gets a distinct stable attempt identity", async () => {
  const { buildPlan } = await import("../run.mjs");
  const { trialId } = await import("./compare.mjs");
  const plan = buildPlan(selectCases(), { mode: "live", seed: 1, repetitions: 1 });
  const ids = plan.trials.flatMap((p) => arms.map((arm) => trialId(p, arm)));
  assert.equal(new Set(ids).size, plan.trials.length * arms.length);
  assert.deepEqual(
    ids,
    plan.trials.flatMap((p) => arms.map((arm) => trialId(p, arm))),
  );
});
