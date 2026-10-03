import assert from "node:assert/strict";
import test from "node:test";
import { gradeTrial, summarize } from "./grader.mjs";

const caseSpec = {
  id: "save",
  family: "form",
  split: "regression",
  category: "identity",
  expected: {
    outcome: "found",
    actions: [{ step: 1, action: "click", outcome: "found", target: { selector: "#save" } }],
  },
};
const trial = () => ({
  caseId: "save",
  attempt: 1,
  repetition: 1,
  elapsedMs: 20,
  result: {
    action: "click",
    outcome: "found",
    actions: [
      {
        actionId: "a1",
        order: 1,
        step: 1,
        action: "click",
        outcome: "found",
        target: {
          xpaths: ["//button"],
          state: {
            rendered: true,
            inViewport: true,
            enabled: true,
            editable: false,
            accessibilityExposed: true,
            readonly: false,
          },
          interactability: { version: "2", action: "click" },
        },
      },
    ],
    diagnostics: {},
  },
  evidence: null,
  observation: { actions: [{ matches: [{ count: 1, intended: true }] }] },
});

test("a unique XPath passes only when the independent oracle identifies the intended node", () => {
  assert.equal(gradeTrial(caseSpec, trial()).passed, true);
  const wrong = trial();
  wrong.observation.actions[0].matches[0].intended = false;
  const grade = gradeTrial(caseSpec, wrong);
  assert.equal(grade.passed, false);
  assert.ok(grade.failures.some(({ category }) => category === "target_identity"));
  const missing = trial();
  missing.result = null;
  assert.equal(gradeTrial(caseSpec, missing).passed, false);
});

test("the response requires one shared action and independently correct target items", () => {
  const spec = { ...caseSpec };
  const actual = trial();
  actual.result.action = "click";
  assert.equal(gradeTrial(spec, actual).passed, true);
  actual.result.action = "hover";
  assert.equal(gradeTrial(spec, actual).passed, false);
});

test("offline identity grading rejects wrong targets and fabricated browser evidence", () => {
  const spec = {
    ...caseSpec,
    track: "offline-selection",
    expected: {
      outcome: "found",
      actions: [{ step: 1, action: "click", outcome: "found", target: { candidateId: "c2" } }],
    },
  };
  const actual = trial();
  actual.result.action = "click";
  actual.result.actions[0].target = { candidateId: "c2" };
  actual.observation = {};
  assert.equal(gradeTrial(spec, actual).passed, true);
  assert.equal(gradeTrial(spec, actual).metrics.readinessExpected, 0);
  actual.result.actions[0].target.candidateId = "c1";
  assert.equal(gradeTrial(spec, actual).metrics.wrongTargets, 1);
  actual.result.actions[0].target = { candidateId: "c2", xpaths: ["//button"] };
  assert.equal(gradeTrial(spec, actual).passed, false);
});

test("decomposition, ordered outcomes, partial state and request summary are independent assertions", () => {
  const expected = structuredClone(caseSpec);
  expected.expected.actions[0].state = { enabled: false };
  expected.expected.actions[0].interactability = {
    status: "blocked",
    reasons: ["disabled"],
    checks: { enabled: "fail" },
  };
  expected.expected.summary = { total: 1, found: 1, blocked: 1 };
  const correct = trial();
  Object.assign(correct.result.actions[0].target, {
    state: {
      rendered: true,
      inViewport: true,
      enabled: true,
      editable: false,
      accessibilityExposed: true,
      readonly: false,
      enabled: false,
      rendered: true,
    },
    interactability: {
      version: "2",
      action: "click",
      status: "blocked",
      reasons: ["disabled"],
      checks: { enabled: "fail", stability: "unknown" },
    },
  });
  correct.result.summary = { total: 1, found: 1, blocked: 1, semanticCompleteness: "unverified" };
  assert.equal(gradeTrial(expected, correct).passed, true);
  for (const mutate of [
    (value) => value.result.actions.pop(),
    (value) => value.result.actions.push(structuredClone(value.result.actions[0])),
    (value) => {
      value.result.actions[0].step = 2;
    },
    (value) => {
      value.result.actions[0].action = "inspect";
    },
    (value) => {
      value.result.actions[0].target.state.enabled = true;
    },
    (value) => {
      value.result.actions[0].target.interactability.reasons = [];
    },
    (value) => {
      value.result.summary.blocked = 0;
    },
    (value) => {
      value.result.actions[0] = null;
    },
  ]) {
    const bad = structuredClone(correct);
    mutate(bad);
    assert.equal(gradeTrial(expected, bad).passed, false);
  }
  const absent = trial();
  absent.result.actions[0].outcome = "not_found";
  absent.result.actions[0].target = null;
  assert.equal(gradeTrial(caseSpec, absent).metrics.falseNotFound, 1);
});

test("provider errors, leaked evidence and incomplete coverage remain distinct from semantic mistakes", () => {
  const failureCase = {
    ...caseSpec,
    expected: { outcome: "error", code: "provider_timeout", actions: [] },
  };
  const providerFailure = trial();
  Object.assign(providerFailure.result, {
    outcome: "error",
    action: null,
    summary: null,
    actions: [],
    diagnostics: { code: "provider_timeout" },
  });
  const recognized = gradeTrial(failureCase, providerFailure);
  assert.equal(recognized.passed, true);
  assert.equal(recognized.metrics.operationalError, true);
  assert.equal(recognized.metrics.expectedOperationalError, true);
  assert.equal(recognized.metrics.semanticFailure, false);
  const brokenHarness = {
    ...providerFailure,
    error: { code: "fixture_viewport", message: "Fixture viewport mismatch" },
  };
  assert.equal(gradeTrial(failureCase, brokenHarness).passed, false);
  providerFailure.result.diagnostics.code = "different_failure";
  assert.equal(gradeTrial(failureCase, providerFailure).passed, false);
  const protectedCase = {
    ...caseSpec,
    privacySentinels: ["private-canary"],
    oracleSentinels: ["oracle-canary"],
  };
  for (const bad of [
    { evidence: { modelInput: '{"label":"oracle-canary"}' } },
    { result: { ...trial().result, message: "private-canary" } },
    { observation: { ...trial().observation, oracleLeak: true } },
    { observation: { ...trial().observation, captureCoverage: { expected: 3, found: 2 } } },
    { observation: { ...trial().observation, modelInputCoverage: { expected: 3, found: 2 } } },
  ])
    assert.equal(gradeTrial(protectedCase, { ...trial(), ...bad }).passed, false);
  assert.equal(
    gradeTrial(protectedCase, {
      ...trial(),
      observation: { ...trial().observation, expected: "oracle-canary" },
    }).passed,
    true,
  );
  assert.equal(gradeTrial(caseSpec, trial()).metrics.modelInputCoverage, null);
});

test("late provider accounting reports charged timeout usage without changing the failed result", () => {
  const actual = trial();
  actual.elapsedMs = 2004;
  actual.result = {
    outcome: "error",
    action: null,
    summary: null,
    actions: [],
    diagnostics: { code: "resolution_timeout", providerAccounting: "pending", modelCalls: 1 },
  };
  actual.provider = [
    {
      forwarded: true,
      reportedUsd: 0.002,
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        completion_tokens_details: { reasoning_tokens: 0 },
        prompt_tokens_details: { cached_tokens: 50 },
      },
    },
  ];
  const original = structuredClone(actual);
  const grade = gradeTrial(caseSpec, actual);
  assert.equal(grade.passed, false);
  assert.equal(grade.metrics.operationalError, true);
  assert.equal(grade.metrics.latencyMs, 2004);
  assert.equal(grade.metrics.accountingSource, "provider_records");
  assert.equal(grade.metrics.reportedCostUsd, 0.002);
  assert.deepEqual(grade.metrics.usage, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    reasoningTokens: 0,
    cachedTokens: 50,
  });
  const report = summarize({ cases: [caseSpec], plan: { repetitions: 1, caseOrder: ["save"] } }, [
    actual,
  ]);
  assert.equal(report.firstAttempt.cost.reportedUsd.total, 0.002);
  assert.equal(report.firstAttempt.usage.inputTokens.total, 100);
  assert.equal(report.firstAttempt.accountingSources.provider_records, 1);
  assert.deepEqual(actual, original);
});

test("unavailable accounting does not change a successful resolver grade", () => {
  const actual = trial();
  actual.accountingError = "Billing unavailable";
  assert.equal(gradeTrial(caseSpec, actual).passed, true);
});

test("provider accounting sums each forwarded call and preserves unknown charges and usage", () => {
  const actual = trial();
  actual.result.diagnostics = {
    modelCalls: 1,
    usage: { cost: 9, inputTokens: 999 },
  };
  actual.provider = [
    { forwarded: true, reportedUsd: 0.002, usage: { prompt_tokens: 100 } },
    { forwarded: true, reportedUsd: 0.003, usage: { prompt_tokens: 200 } },
    { forwarded: false, reportedUsd: 7, usage: { prompt_tokens: 999 } },
  ];
  let metrics = gradeTrial(caseSpec, actual).metrics;
  assert.equal(metrics.reportedCostUsd, 0.005);
  assert.equal(metrics.usage.inputTokens, 300);
  assert.equal(metrics.usage.reasoningTokens, null);
  actual.provider[1].usage = null;
  metrics = gradeTrial(caseSpec, actual).metrics;
  assert.equal(metrics.reportedCostUsd, 0.005);
  assert.equal(metrics.usage.inputTokens, null);
  actual.provider[1].reportedUsd = null;
  assert.equal(gradeTrial(caseSpec, actual).metrics.reportedCostUsd, null);
  actual.provider = [];
  metrics = gradeTrial(caseSpec, actual).metrics;
  assert.equal(metrics.reportedCostUsd, null);
  assert.equal(metrics.usage.inputTokens, null);
  actual.result.diagnostics.modelCalls = 0;
  metrics = gradeTrial(caseSpec, actual).metrics;
  assert.equal(metrics.reportedCostUsd, 0);
  assert.equal(metrics.usage.inputTokens, 0);
});

test("saved locator reuse is graded separately from fresh resolution after a mutation", () => {
  const expected = {
    ...caseSpec,
    mutation: { expected: "preserved", afterExpected: caseSpec.expected },
  };
  const changed = {
    ...trial(),
    mutation: { expected: "preserved", matches: [{ count: 1, intended: true }], fresh: trial() },
  };
  assert.equal(gradeTrial(expected, changed).passed, true);
  changed.mutation.matches[0].intended = false;
  const grade = gradeTrial(expected, changed);
  assert.equal(grade.passed, false);
  assert.equal(grade.metrics.savedLocator.passed, false);
  assert.equal(grade.metrics.freshResolution.passed, true);
  const removed = {
    ...expected,
    mutation: {
      expected: "removed",
      afterExpected: {
        outcome: "not_found",
        actions: [{ step: 1, action: "click", outcome: "not_found" }],
      },
    },
  };
  changed.mutation.expected = "removed";
  changed.mutation.matches = [{ count: 0, intended: false }];
  changed.mutation.fresh.result.outcome = "not_found";
  changed.mutation.fresh.result.actions[0].outcome = "not_found";
  changed.mutation.fresh.result.actions[0].target = null;
  assert.equal(gradeTrial(removed, changed).passed, true);
  changed.mutation.matches[0].count = 1;
  assert.equal(gradeTrial(removed, changed).passed, false);
  const forged = {
    ...trial(),
    mutation: { expected: "removed", matches: [{ count: 0, intended: false }], fresh: trial() },
  };
  assert.equal(
    gradeTrial(
      { ...caseSpec, mutation: { kind: "wrapper", afterExpected: caseSpec.expected } },
      forged,
    ).passed,
    false,
  );
  assert.equal(gradeTrial(expected, trial()).passed, false);
  const active = trial();
  active.observation.passiveStateUnchanged = false;
  assert.equal(gradeTrial(caseSpec, active).passed, false);
});

test("reports recompute first attempts, preserve missing repetitions and isolate diagnostic reruns", () => {
  const manifest = { cases: [caseSpec], plan: { repetitions: 3, caseOrder: ["save"] } };
  const first = trial();
  first.elapsedMs = 10;
  first.result.diagnostics = {
    usage: { cost: 0.001, inputTokens: 12 },
    costEstimate: { totalCost: 0.002 },
    timingsMs: { inference: 7 },
  };
  const second = trial();
  second.repetition = 2;
  second.elapsedMs = 30;
  second.observation.actions[0].matches[0].intended = false;
  second.grade = { passed: true };
  const rerun = { ...trial(), repetition: 2, attempt: 2, elapsedMs: 15 };
  const report = summarize(manifest, [first, second, rerun]);
  assert.equal(report.qualification, "incomplete");
  assert.equal(report.mode, "unavailable");
  assert.equal(report.modelQualityMeasured, false);
  assert.equal(report.passed, false);
  assert.equal(report.plannedTrials, 3);
  assert.equal(report.completedTrials, 2);
  assert.equal(report.missingTrials, 1);
  assert.equal(report.firstAttempt.passed, 1);
  assert.equal(report.firstAttempt.passRate, 1 / 3);
  assert.deepEqual(report.firstAttempt.latencyMs, {
    p50: 10,
    p95: 30,
    observed: 2,
    unavailable: 1,
  });
  assert.equal(report.diagnosticReruns.passed, 1);
  assert.equal(report.firstAttempt.metrics.targetsCorrect, 1);
  assert.equal(report.firstAttempt.metrics.wrongTargets, 1);
  assert.deepEqual(report.firstAttempt.cost.reportedUsd, {
    total: null,
    observedTotal: 0.001,
    observed: 1,
    unavailable: 2,
  });
  assert.equal(report.firstAttempt.usage.inputTokens.observedTotal, 12);
  assert.equal(report.firstAttempt.usage.reasoningTokens.total, null);
  assert.equal(report.groups.family.form.trials, 3);
  assert.ok(
    report.failures.some(
      (failure) => failure.category === "missing_trial" && failure.repetition === 3,
    ),
  );
  const duplicate = summarize({ ...manifest, plan: { repetitions: 1, caseOrder: ["save"] } }, [
    first,
    first,
  ]);
  assert.equal(duplicate.passed, false);
  assert.equal(duplicate.completedTrials, 1);
  assert.ok(duplicate.failures.some((failure) => failure.category === "duplicate_trial"));
  assert.equal(summarize({ ...manifest, mode: "live" }, [first]).modelQualityMeasured, true);
  assert.equal(
    summarize({ ...manifest, mode: "deterministic" }, [first]).modelQualityMeasured,
    false,
  );
});

test("malformed alternatives and unsupported/readiness assertions remain visible in aggregate metrics", () => {
  for (const change of [
    (value) => {
      value.result.actions[0].target.xpaths = ["//button", "//aside"];
      value.observation.actions[0].matches.push({ count: 1, intended: false });
    },
    (value) => {
      value.observation.actions[0].matches[0].count = 2;
    },
    (value) => {
      value.result.actions = {};
    },
    (value) => {
      value.result = "malformed";
    },
  ]) {
    const value = trial();
    change(value);
    assert.equal(gradeTrial(caseSpec, value).passed, false);
  }
  const unsupported = {
    ...caseSpec,
    expected: {
      outcome: "unsupported",
      actions: [{ step: 1, action: "click", outcome: "unsupported" }],
    },
  };
  const observed = trial();
  observed.result.outcome = "unsupported";
  observed.result.actions[0].outcome = "unsupported";
  observed.result.actions[0].target = null;
  assert.equal(gradeTrial(unsupported, observed).metrics.unsupportedCorrect, 1);
  const labelled = structuredClone(caseSpec);
  labelled.expected.actions[0].interactability = { status: "ready", reasons: [] };
  const ready = trial();
  ready.result.actions[0].target.interactability = {
    version: "2",
    action: "click",
    status: "ready",
    reasons: [],
  };
  const report = summarize({ cases: [labelled], plan: { caseOrder: ["save"], repetitions: 1 } }, [
    ready,
  ]);
  assert.equal(report.firstAttempt.metrics.readinessAccuracy, 1);
});

test("an operational action failure in a partial result does not masquerade as a wrong target", () => {
  const expected = structuredClone(caseSpec);
  expected.expected.actions.push({
    step: 2,
    action: "click",
    outcome: "found",
    target: { selector: "#cancel" },
  });
  const partial = trial();
  partial.result.outcome = "partial";
  partial.result.actions.push({
    actionId: "a2",
    order: 2,
    step: 2,
    action: "click",
    outcome: "error",
    code: "stale_capture",
    target: null,
  });
  const grade = gradeTrial(expected, partial);
  assert.equal(grade.passed, false);
  assert.equal(grade.metrics.operationalError, true);
  assert.equal(grade.metrics.semanticFailure, false);
  assert.equal(grade.metrics.targetsCorrect, 1);
  assert.equal(grade.metrics.wrongTargets, 0);
  expected.expected.outcome = "partial";
  expected.expected.actions[1].outcome = "error";
  delete expected.expected.actions[1].target;
  const recognized = gradeTrial(expected, partial);
  assert.equal(recognized.passed, true);
  assert.equal(recognized.metrics.expectedOperationalError, true);
});

test("malformed results and capture leaks fail even when resolution also errors", () => {
  const errorCase = {
    ...caseSpec,
    expected: { outcome: "error", code: "provider_timeout", actions: [] },
  };
  const errorResult = {
    ...trial(),
    result: {
      outcome: "error",
      actions: [],
      summary: null,
      diagnostics: { code: "provider_timeout" },
    },
  };
  assert.equal(gradeTrial(errorCase, errorResult).passed, true);
  for (const mutate of [
    (value) => {
      value.result.action = "click";
    },
    (value) => {
      value.result.target = { xpaths: ["//button"] };
    },
    (value) => {
      value.result.summary = { total: 0 };
    },
    (value) => {
      value.result.actions = trial().result.actions;
    },
    (value) => {
      value.captureObservation = { privacyLeak: true };
      value.error = { code: "observation_failed" };
    },
  ]) {
    const value = structuredClone(errorResult);
    mutate(value);
    assert.equal(gradeTrial(errorCase, value).passed, false);
  }
  for (const mutate of [
    (value) => {
      delete value.result.actions[0].target.state.rendered;
    },
    (value) => {
      delete value.result.actions[0].target.interactability;
    },
    (value) => {
      value.result.actions[0].target.interactability.action = "fill";
    },
    (value) => {
      value.result.attemptId = "attempt";
      value.result.actions[0].diagnosticsReference = "other";
    },
  ]) {
    const value = trial();
    mutate(value);
    assert.equal(gradeTrial(caseSpec, value).passed, false);
  }
  const malformedError = trial();
  malformedError.result.outcome = "error";
  malformedError.observation.actions[0].matches[0].intended = false;
  const grade = gradeTrial(caseSpec, malformedError);
  assert.ok(grade.failures.some(({ category }) => category === "target_identity"));
  assert.ok(grade.failures.some(({ category }) => category === "contract"));
  const leaked = {
    ...errorResult,
    captureObservation: { privacyLeak: true },
    error: { code: "observation_failed" },
  };
  assert.equal(gradeTrial(errorCase, leaked).metrics.privacyLeak, true);
});

test("offline forecast preserves unmeasured usage and labels cross-split extrapolation", () => {
  const spec = {
    id: "sample",
    dataset: "phrasenode",
    split: "train",
    family: "page",
    track: "offline-selection",
    expected: {
      outcome: "found",
      actions: [{ step: 1, outcome: "found", target: { candidateId: "n1" } }],
    },
  };
  const manifest = {
    track: "offline-selection",
    mode: "live",
    cases: [spec],
    plan: { caseOrder: [spec.id], repetitions: 1 },
    selection: { split: "train" },
    inventory: {
      splits: {
        train: { statuses: { "offline-eligible": 100 } },
        test: { statuses: { "offline-eligible": 20 } },
      },
    },
    pricing: { prompt: "0.0000001", completion: "0.000001" },
  };
  assert.equal(summarize(manifest, []).forecast.splits.train.projectedUsd, null);
  const report = summarize(manifest, [
    {
      caseId: spec.id,
      result: {
        outcome: "found",
        action: "inspect",
        actions: [
          {
            actionId: "a1",
            order: 1,
            step: 1,
            action: "inspect",
            outcome: "found",
            target: { candidateId: "n1" },
          },
        ],
        diagnostics: { usage: { inputTokens: 1000, outputTokens: 100, cost: 0.0002 } },
      },
    },
  ]);
  assert.equal(report.forecast.measuredTrials, 1);
  assert.ok(Math.abs(report.forecast.splits.train.projectedUsd - 0.02) < 1e-12);
  assert.match(report.forecast.splits.test.limitation, /another split/);
});

test("one interaction cannot duplicate a candidate to inflate target completeness", () => {
  const expected = {
    outcome: "found",
    actions: [1, 2].map((step) => ({
      step,
      action: "click",
      outcome: "found",
      target: { candidateId: "n1" },
    })),
  };
  const grade = gradeTrial(
    { track: "offline-selection", expected },
    {
      result: {
        outcome: "found",
        action: "click",
        actions: [1, 2].map((step) => ({
          actionId: `a${step}`,
          order: step,
          step,
          action: "click",
          outcome: "found",
          target: { candidateId: "n1" },
        })),
      },
    },
  );
  assert.equal(grade.passed, false);
  assert.ok(grade.failures.some((item) => /more than once/.test(item.detail)));
});

test("plural reports distinguish missing, extra, duplicate and wrong targets", () => {
  const spec = {
    track: "offline-selection",
    expected: {
      outcome: "found",
      actions: ["n1", "n2"].map((candidateId, i) => ({
        step: i + 1,
        action: "click",
        outcome: "found",
        target: { candidateId },
      })),
    },
  };
  for (const [ids, missing, extra, duplicate, wrong, complete] of [
    [["n1", "n2"], 0, 0, 0, 0, 1],
    [["n1"], 1, 0, 0, 0, 0],
    [["n1", "n2", "n3"], 0, 1, 0, 1, 0],
    [["n1", "n1"], 1, 1, 1, 1, 0],
    [["n9", "n2"], 1, 1, 0, 1, 0],
  ]) {
    const result = {
      outcome: "found",
      action: "click",
      actions: ids.map((candidateId, i) => ({
        actionId: `a${i + 1}`,
        step: i + 1,
        order: i + 1,
        action: "click",
        outcome: "found",
        target: { candidateId },
      })),
    };
    const { metrics } = gradeTrial(spec, { result });
    assert.deepEqual(
      [
        metrics.missingTargets,
        metrics.extraTargets,
        metrics.duplicateTargets,
        metrics.wrongTargets,
        metrics.targetSetsComplete,
      ],
      [missing, extra, duplicate, wrong, complete],
    );
  }
});
