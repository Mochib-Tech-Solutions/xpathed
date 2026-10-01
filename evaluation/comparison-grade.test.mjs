import assert from "node:assert/strict";
import test from "node:test";
import { gradeComparison } from "./comparison-grade.mjs";

const spec = (count = 1) => ({
  expected: {
    actions: Array.from({ length: count }, () => ({ action: "click", outcome: "found" })),
  },
});
const trial = (indices = [0]) => ({
  result: {
    outcome: "found",
    action: "click",
    actions: indices.map(() => ({
      action: "click",
      outcome: "found",
      target: { xpaths: ["//button"] },
    })),
  },
  observation: {
    passiveStateUnchanged: true,
    actions: indices.map((index) => ({
      matches: [
        {
          count: 1,
          expectedIndices: index < 0 ? [] : [index],
          nodeId: `node-${index}`,
          eligible: true,
        },
      ],
    })),
  },
});

test("comparison judges independent identity without requiring resolver readiness", () => {
  assert.equal(gradeComparison(spec(), trial()).passed, true);
  const wrong = gradeComparison(spec(), trial([-1]));
  assert.equal(wrong.passed, false);
  assert.equal(wrong.metrics.wrongTargets, 1);
  assert.equal(wrong.metrics.missingTargets, 1);
});

test("plural matching is order independent and retains missing, extra and duplicate targets", () => {
  assert.equal(gradeComparison(spec(2), trial([1, 0])).passed, true);
  for (const [indices, missing, extra, duplicate] of [
    [[0], 1, 0, 0],
    [[0, 1, -1], 0, 1, 0],
    [[0, 0], 1, 1, 1],
    [[-1, -1], 2, 2, 1],
  ]) {
    const grade = gradeComparison(spec(2), trial(indices));
    assert.equal(grade.passed, false);
    assert.equal(grade.metrics.missingTargets, missing);
    assert.equal(grade.metrics.extraTargets, extra);
    assert.equal(grade.metrics.duplicateTargets, duplicate);
  }
});

test("wrong first plus correct later is not rescued and empty suggestions fail an existing target", () => {
  assert.equal(gradeComparison(spec(), trial([-1, 0])).passed, false);
  const empty = trial([]);
  empty.result.outcome = "not_found";
  assert.equal(gradeComparison(spec(), empty).passed, false);
  empty.result.action = null;
  assert.equal(
    gradeComparison({ expected: { actions: [{ action: "click", outcome: "not_found" }] } }, empty)
      .passed,
    true,
  );
});

test("wrong interaction and page mutations fail even on the correct node", () => {
  const wrong = trial();
  wrong.result.action = "hover";
  wrong.result.actions[0].action = "hover";
  assert.equal(gradeComparison(spec(), wrong).passed, false);
  const changed = trial();
  changed.observation.passiveStateUnchanged = false;
  assert.equal(gradeComparison(spec(), changed).passed, false);
  delete changed.observation.passiveStateUnchanged;
  assert.equal(gradeComparison(spec(), changed).passed, false);
});

test("hidden, ambiguous, malformed and unsupported selections are never successful", () => {
  for (const edit of [
    (t) => {
      t.observation.actions[0].matches[0].eligible = false;
    },
    (t) => {
      t.observation.actions[0].matches[0].count = 2;
    },
    (t) => {
      t.result.actions[0].target.xpaths.push("//other");
    },
    (t) => {
      t.result.actions[0].outcome = "not_found";
    },
    (t) => {
      t.result.actions[0].action = "fill";
    },
    (t) => {
      t.result.outcome = "error";
    },
    (t) => {
      t.result.outcome = "unsupported";
    },
  ]) {
    const t = trial();
    edit(t);
    assert.equal(gradeComparison(spec(), t).passed, false);
  }
});

test("invalid oracle mappings and partial target claims cannot become complete success", () => {
  const duplicateLabels = trial();
  duplicateLabels.observation.actions[0].matches[0].expectedIndices = [0, 1];
  assert.equal(gradeComparison(spec(2), duplicateLabels).passed, false);
  const partial = trial();
  partial.result.outcome = "partial";
  partial.result.actions.push({ action: "click", outcome: "not_found" });
  assert.equal(gradeComparison(spec(), partial).passed, false);
});

const liveTrial = (strategy = "stagehand") => ({
  ...trial(),
  mode: "live",
  strategy,
  modelCalls: 1,
  cache: { status: "DISABLED" },
  provider: [{ forwarded: true, reservedUsd: 0.01, reportedUsd: 0.001 }],
});

test("live grading separates response reuse from fresh inference and provider prompt caching", () => {
  const live = liveTrial();
  live.provider[0].usage = { prompt_tokens_details: { cached_tokens: 100 } };
  const fresh = gradeComparison(spec(), live);
  assert.equal(fresh.passed, true);
  assert.equal(fresh.metrics.freshInference, true);
  assert.equal(fresh.metrics.reusedResponse, false);
  const reused = liveTrial();
  reused.cache.status = "HIT";
  reused.modelCalls = 0;
  reused.provider = [];
  const cached = gradeComparison(spec(), reused);
  assert.equal(cached.passed, false);
  assert.equal(cached.metrics.freshInference, false);
  assert.equal(cached.metrics.reusedResponse, true);
  assert.ok(cached.failures.some((f) => f.category === "fresh_inference"));
  for (const edit of [
    (t) => {
      t.modelCalls = 2;
    },
    (t) => {
      t.provider.push({ ...t.provider[0] });
    },
    (t) => {
      t.provider[0].forwarded = false;
    },
    (t) => {
      delete t.cache;
    },
  ]) {
    const t = liveTrial();
    edit(t);
    assert.equal(gradeComparison(spec(), t).passed, false);
  }
  const custom = liveTrial("custom");
  delete custom.cache;
  assert.equal(gradeComparison(spec(), custom).passed, true);
});

test("live charge gaps and excess charges fail accounting without hiding operational failures", () => {
  for (const cost of [null, undefined, -1, NaN, 0.02]) {
    const t = liveTrial();
    t.provider[0].reportedUsd = cost;
    const grade = gradeComparison(spec(), t);
    assert.equal(grade.passed, false);
    assert.ok(grade.failures.some((f) => f.category === "accounting"));
  }
  const failed = {
    mode: "live",
    strategy: "stagehand",
    error: { message: "timeout" },
    provider: [],
  };
  const grade = gradeComparison(spec(), failed);
  assert.equal(grade.metrics.operationalError, true);
  assert.equal(grade.metrics.freshInference, null);
  assert.equal(grade.metrics.reusedResponse, null);
  assert.equal(
    grade.failures.some((f) => f.category === "fresh_inference"),
    false,
  );
  assert.equal(gradeComparison(spec(), { ...trial(), mode: "deterministic" }).passed, true);
});

test("provider-limit comparisons keep cost gaps and overruns out of target correctness", () => {
  for (const [reservedUsd, reportedUsd] of [
    [null, null],
    [0.01, 0.02],
  ]) {
    const trial = liveTrial();
    trial.provider[0] = { ...trial.provider[0], reservedUsd, reportedUsd };
    assert.equal(gradeComparison(spec(), trial, "provider-limit").passed, true);
  }
  const invalid = liveTrial();
  invalid.provider[0].reportedUsd = -1;
  assert.ok(
    gradeComparison(spec(), invalid, "provider-limit").failures.some(
      (f) => f.category === "accounting",
    ),
  );
});
