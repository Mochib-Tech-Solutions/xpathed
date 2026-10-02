import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import policy from "./qualification-policy.json" with { type: "json" };
import { compareTrials, compareMeasurements, measuredEntry } from "./release-comparison.mjs";
import { summarizeQualification } from "./qualification-policy.mjs";
import currentViewPolicy from "./current-view-qualification-policy.json" with { type: "json" };

function evidence() {
  const cases = Array.from({ length: 11 }, (_, index) => ({
    id: `case-${index}`,
    family: `family-${index}`,
    split: index === 10 ? "regression" : "held-out",
    contractVersion: "3",
    expected: {
      outcome: "found",
      actions: (index === 0 ? [1, 2] : [1]).map((step) => ({
        step,
        action: "click",
        outcome: "found",
        target: { selector: `#button-${step}` },
      })),
      summary: { processingComplete: true },
    },
  }));
  const plan = cases.flatMap((spec) =>
    [1, 2, 3].map((repetition) => ({
      id: `${spec.id}-${repetition}`,
      caseId: spec.id,
      profileId: "candidate",
      repetition,
      attempt: 1,
    })),
  );
  const manifest = {
    mode: "live",
    cases,
    profiles: [{ id: "candidate", model: "test/model", provider: "test-provider" }],
    baselineEvidence: {
      runId: "development-baseline",
      profiles: { candidate: { criticalFailures: [], hardFailures: [], capabilityGaps: [] } },
    },
    plan: { trials: plan },
    qualification: {
      policySha256: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
      frozenAt: "2026-09-30T12:00:00Z",
      heldOutStartedAt: "2026-09-30T13:00:00Z",
      baselineRunIds: ["development-baseline"],
    },
  };
  const trials = plan.map((entry) => {
    const spec = cases.find(({ id }) => id === entry.caseId);
    return {
      ...entry,
      elapsedMs: 1900,
      provider: [
        {
          forwarded: true,
          identityValid: true,
          requestedIdentity: { model: "test/model", provider: "test-provider" },
          observedIdentity: {
            model: "test/model",
            provider: "Test Provider",
            generationId: entry.id,
          },
          responseReuseDisabled: true,
          responseCacheHit: false,
          reportedUsd: 0.001,
        },
      ],
      result: {
        contractVersion: "3",
        action: "click",
        outcome: "found",
        actions: spec.expected.actions.map(({ step }) => ({
          actionId: `a${step}`,
          order: step,
          step,
          action: "click",
          outcome: "found",
          target: {
            candidateId: `c${step}`,
            xpaths: [`//button[@id='button-${step}']`],
            state: { version: "2" },
            interactability: { version: "2", action: "click" },
          },
        })),
        summary: { processingComplete: true },
        diagnostics: { usage: { cost: 0.001 } },
      },
      observation: {
        actions: spec.expected.actions.map(() => ({ matches: [{ count: 1, intended: true }] })),
      },
    };
  });
  return { manifest, trials };
}

test("a fully observed frozen live candidate qualifies without activating a default", () => {
  const { manifest, trials } = evidence();
  const report = summarizeQualification(manifest, trials);
  assert.equal(report.profiles.candidate.qualification.status, "qualified");
  assert.equal(report.profiles.candidate.qualification.correctCompleteWithinDeadline.rate, 1);
  assert.equal(report.profiles.candidate.qualification.correctCompleteWithinGoal.rate, 0);
  assert.equal(report.profiles.candidate.qualification.uncertainty.heldOutFamilies, 10);
  assert.equal(report.profiles.candidate.firstAttempt.latencyMs.p95, 1900);
  assert.ok(
    Math.abs(report.profiles.candidate.firstAttempt.cost.reportedUsd.total - 0.033) < 1e-12,
  );
  assert.equal(report.defaultActivated, false);
});

test("current-view release qualification requires its own coverage and measured protocol", () => {
  const { manifest, trials } = evidence();
  manifest.qualification.policySha256 = createHash("sha256")
    .update(JSON.stringify(currentViewPolicy))
    .digest("hex");
  const status = () =>
    summarizeQualification(manifest, trials, currentViewPolicy).profiles.candidate.qualification;
  assert.equal(status().status, "insufficient-evidence");
  assert.ok(status().reasons.includes("current_view_coverage_insufficient"));
  manifest.cases = trials.map((trial) => ({
    ...manifest.cases.find((c) => c.id === trial.caseId),
    id: trial.id,
    contractVersion: "4",
  }));
  for (const trial of trials) {
    trial.caseId = trial.id;
    trial.repetition = 1;
    trial.result.contractVersion = "4";
  }
  manifest.plan.trials = trials.map(({ id, caseId, profileId, repetition, attempt }) => ({
    id,
    caseId,
    profileId,
    repetition,
    attempt,
  }));
  assert.ok(status().reasons.includes("latency_protocol_mismatch"));
  manifest.measurement = { latencyProtocol: currentViewPolicy.latencyProtocol };
  assert.ok(status().reasons.includes("baseline_missing"));
  manifest.comparison = { profile: manifest.profiles[0] };
  for (const trial of trials) {
    trial.baseline = structuredClone(trial);
    trial.baseline.profileId = "release-baseline";
    trial.baseline.id = createHash("sha256")
      .update(`${trial.id}:baseline`)
      .digest("hex")
      .slice(0, 32);
    trial.baseline.provider[0].observedIdentity.generationId += "-baseline";
    trial.baseline.elapsedMs = 4000;
    trial.elapsedMs = 3500;
  }
  // Existing model failures do not impose an absolute accuracy gate.
  for (const trial of trials.slice(0, 4)) {
    trial.observation.actions[0].matches[0].intended = false;
    trial.baseline.observation.actions[0].matches[0].intended = false;
  }
  assert.equal(status().status, "qualified");
  assert.ok(status().correctness.rate < 0.95);
  assert.equal(status().correctCompleteWithinDeadline.rate, 0);
  trials[4].observation.actions[0].matches[0].intended = false;
  assert.ok(status().reasons.includes("correctness_regression"));
  trials[0].observation.actions[0].matches[0].intended = true;
  assert.equal(status().status, "qualified");
  assert.deepEqual(status().comparison.regressions, [trials[4].caseId]);
  assert.deepEqual(status().comparison.gains, [trials[0].caseId]);
  assert.equal(
    compareTrials(manifest, trials, { ...currentViewPolicy, version: "6" }).status,
    "semantic_drift",
  );
  trials[4].observation.actions[0].matches[0].intended = true;
  trials[0].elapsedMs = 9000;
  trials[1].elapsedMs = 9000;
  assert.equal(status().status, "qualified");
  assert.equal(status().comparison.candidate.p95, 9000);
  trials[0].baseline.elapsedMs = null;
  assert.equal(compareTrials(manifest, trials, currentViewPolicy).status, "infrastructure_failure");
});

test("paired baseline reports both contracts, keeps missing attempts and excludes scope changes from speed gains", () => {
  const source = evidence();
  const v3 = {
    ...source.manifest.cases[1],
    id: "before",
    split: "development",
    pairId: "same-target",
    baselineStratum: "paired",
  };
  const v4 = { ...v3, id: "after", contractVersion: "4" };
  const edge = { ...v4, id: "edge", pairId: undefined, baselineStratum: "scope-change" };
  const specs = [v3, v4, edge];
  const manifest = {
    ...source.manifest,
    baseline: { version: 1, kind: "viewport-paired" },
    cases: specs,
    plan: {
      trials: specs.map((c) => ({
        id: c.id,
        caseId: c.id,
        profileId: "candidate",
        repetition: 1,
        attempt: 1,
      })),
    },
  };
  const original = source.trials[3];
  const trials = [v3, v4].map((c, index) => ({
    ...structuredClone(original),
    id: c.id,
    caseId: c.id,
    repetition: 1,
    elapsedMs: index ? 800 : 1400,
    provider: original.provider.map((record) => ({
      ...record,
      usage: { prompt_tokens: index ? 100 : 400 },
    })),
    result: {
      ...structuredClone(original.result),
      contractVersion: c.contractVersion,
      diagnostics: {
        usage: { cost: 0.001, inputTokens: index ? 100 : 400 },
        modelInputComplete: true,
        modelInputBytes: index ? 200 : 800,
      },
    },
  }));
  const result = summarizeQualification(manifest, trials);
  assert.deepEqual(result.qualifiedCandidates, []);
  const baseline = result.pairedBaseline;
  assert.equal(baseline.arms["3"].plannedTrials, 1);
  assert.equal(baseline.arms["4"].plannedTrials, 2);
  assert.equal(baseline.arms["4"].correctCompleteWithinGoal.passed, 1);
  assert.equal(baseline.arms["4"].missingTrials, 1);
  assert.equal(baseline.pairs[0].elapsedMsReduction, 600);
  assert.equal(baseline.pairs[0].modelInputBytesReduction, 600);
  assert.equal(baseline.pairs[0].bothCorrect, true);
  assert.equal(baseline.pairs.length, 1);
  assert.equal(baseline.arms["4"].costPerCorrectUsd, null);
  const edgeTrial = structuredClone(trials[1]);
  edgeTrial.id = "edge";
  edgeTrial.caseId = "edge";
  edgeTrial.provider = [{ forwarded: true, reportedUsd: 9 }];
  edgeTrial.result.diagnostics.modelInputBytes = 999999;
  edgeTrial.result.diagnostics.usage.inputTokens = 999999;
  edgeTrial.result.diagnostics.timingsMs = { capture: 99, model: 700 };
  const stratified = summarizeQualification(manifest, [...trials, edgeTrial]).pairedBaseline;
  const paired = stratified.arms["4"].strata.paired;
  assert.equal(paired.modelInputBytes.p50, 200);
  assert.equal(paired.firstAttempt.usage.inputTokens.total, 100);
  assert.equal(paired.reportedPaidUsd, 0.001);
  assert.equal(paired.correctCompleteWithinGoal.passed, 1);
  assert.equal(
    stratified.arms["4"].strata["scope-change"].firstAttempt.stageTimingsMs.capture.p50,
    99,
  );
  assert.equal(stratified.pairedGains.elapsedMs.absoluteReduction, 600);
  assert.ok(
    Math.abs(stratified.pairedGains.elapsedMs.percentReduction - (600 / 1400) * 100) < 1e-9,
  );
  assert.equal(stratified.pairedGains.modelInputBytes.absoluteReduction, 600);
  const timeout = structuredClone(trials[1]);
  timeout.elapsedMs = 1;
  timeout.error = { code: "timeout", message: "timed out" };
  const failed = summarizeQualification(manifest, [trials[0], timeout, edgeTrial]).pairedBaseline;
  assert.equal(failed.pairs[0].elapsedMsReduction, null);
  assert.equal(failed.pairs[0].observedElapsedMsDelta, 1399);
  assert.equal(failed.pairedGains.elapsedMs.absoluteReduction, null);
  assert.equal(failed.pairedGains.elapsedMs.measuredPairs, 0);
  trials[0].result.diagnostics.modelInputComplete = false;
  trials[0].result.diagnostics.modelInputBytes = 0;
  trials[0].result.diagnostics.modelCalls = 1;
  trials[0].provider = [];
  const incomplete = summarizeQualification(manifest, trials).pairedBaseline;
  assert.equal(incomplete.arms["3"].modelInputBytes.observed, 0);
  assert.equal(incomplete.pairs[0].inputTokensReduction, null);
  assert.equal(incomplete.pairs[0].modelInputBytesReduction, null);
  assert.equal(incomplete.arms["3"].reportedPaidUsd, null);
});

test("policy 2 counts only sub-second goals and includes the two-second deadline boundary", () => {
  const { manifest, trials } = evidence();
  for (const trial of trials) trial.elapsedMs = 999;
  trials[0].elapsedMs = 1000;
  trials[1].elapsedMs = 2000;
  trials[2].elapsedMs = 2001;
  const result = summarizeQualification(manifest, trials).profiles.candidate.qualification;
  assert.equal(result.policyVersion, "2");
  assert.equal(result.correctCompleteWithinGoal.passed, 30);
  assert.equal(result.correctCompleteWithinDeadline.passed, 32);
});

test("recorded policy 1 retains its inclusive two-second goal and three-second deadline", () => {
  const { manifest, trials } = evidence();
  const previous = { ...policy, version: "1", goalMs: 2000, deadlineMs: 3000 };
  manifest.qualification.policySha256 = createHash("sha256")
    .update(JSON.stringify(previous))
    .digest("hex");
  for (const trial of trials) trial.elapsedMs = 2000;
  trials[0].elapsedMs = 3000;
  trials[1].elapsedMs = 3001;
  const result = summarizeQualification(manifest, trials, previous).profiles.candidate
    .qualification;
  assert.equal(result.correctCompleteWithinGoal.passed, 31);
  assert.equal(result.correctCompleteWithinDeadline.passed, 32);
});

test("quick wrong or incomplete results fail while every original request remains in the denominator", () => {
  for (const change of [
    (trial) => {
      trial.observation.actions[0].matches[0].intended = false;
    },
    (trial) => {
      trial.result.actions.pop();
    },
    (trial) => {
      trial.result.summary.processingComplete = false;
    },
    (trial) => {
      trial.result.actions[1].target.candidateId = "c1";
    },
  ]) {
    const { manifest, trials } = evidence();
    trials[0].elapsedMs = 1;
    change(trials[0]);
    const report = summarizeQualification(manifest, trials).profiles.candidate;
    assert.equal(report.qualification.status, "not-qualified");
    assert.equal(report.qualification.correctCompleteWithinDeadline.total, 33);
    assert.equal(report.qualification.correctCompleteWithinDeadline.passed, 32);
    assert.equal(report.correctLatencyMs.p50, 1900);
  }
});

test("timeouts, missing attempts and reruns do not disappear from deadline or latency reports", () => {
  const { manifest, trials } = evidence();
  trials[0] = { ...trials[0], result: null, elapsedMs: 45000, error: { code: "timeout" } };
  trials[1] = { ...trials[1], result: null, elapsedMs: 45000, error: { code: "timeout" } };
  const retry = { ...trials[2], id: "retry", attempt: 2 };
  trials.splice(2, 1);
  const report = summarizeQualification(manifest, [...trials, retry]).profiles.candidate;
  assert.equal(report.qualification.correctCompleteWithinDeadline.total, 33);
  assert.equal(report.qualification.correctCompleteWithinDeadline.passed, 30);
  assert.equal(report.firstAttempt.latencyMs.p95, 45000);
  assert.equal(report.firstAttempt.latencyMs.unavailable, 1);
  assert.equal(report.diagnosticReruns.passed, 1);
  assert.equal(report.qualification.status, "not-qualified");
  assert.ok(report.qualification.reasons.includes("planned_trials_missing"));
});

test("deterministic, offline, unsealed or small evidence cannot qualify despite perfect scores", () => {
  for (const change of [
    ({ manifest }) => {
      manifest.mode = "deterministic";
    },
    ({ manifest }) => {
      manifest.track = "offline-selection";
    },
    ({ manifest }) => {
      manifest.qualification.policySha256 = "tampered";
    },
    ({ manifest }) => {
      manifest.qualification.frozenAt = "2026-09-30T14:00:00Z";
    },
    ({ manifest }) => {
      manifest.qualification.baselineRunIds = [];
    },
    ({ manifest }) => {
      manifest.cases
        .filter(({ split }) => split === "held-out")
        .forEach((spec) => {
          spec.family = "same-family";
        });
    },
    ({ manifest }) => {
      manifest.cases[0].family = manifest.cases[10].family;
    },
    ({ manifest }) => {
      for (const spec of manifest.cases) spec.split = "regression";
    },
  ]) {
    const data = evidence();
    change(data);
    const report = summarizeQualification(data.manifest, data.trials).profiles.candidate;
    assert.equal(report.qualification.status, "insufficient-evidence");
  }
});

test("privacy leaks and critical case failures block even a 95-percent aggregate score", () => {
  for (const change of [
    ({ trials }) => {
      trials[0].observation.privacyLeak = true;
    },
    ({ trials }) => {
      trials[0].observation.oracleLeak = true;
    },
    ({ trials }) => {
      trials[0].observation.passiveStateUnchanged = false;
    },
    ({ manifest, trials }) => {
      manifest.cases[0].critical = true;
      trials[0].result.actions[0].action = "hover";
    },
  ]) {
    const data = evidence();
    change(data);
    const report = summarizeQualification(data.manifest, data.trials).profiles.candidate;
    assert.equal(report.firstAttempt.passRate > 0.95, true);
    assert.equal(report.qualification.status, "not-qualified");
  }
});

test("repeated perfect requests do not manufacture independent family confidence", () => {
  const { manifest, trials } = evidence();
  const uncertainty = summarizeQualification(manifest, trials).profiles.candidate.qualification
    .uncertainty;
  assert.equal(uncertainty.successfulFamilies, 10);
  assert.ok(uncertainty.interval95.lower > 0.72 && uncertainty.interval95.lower < 0.73);
  assert.equal(uncertainty.interval95.upper, 1);
});

test("extra regression successes cannot dilute a held-out deadline regression", () => {
  const { manifest, trials } = evidence();
  for (let index = 0; index < 20; index++) {
    const caseId = `extra-${index}`;
    manifest.cases.push({ ...structuredClone(manifest.cases[10]), id: caseId });
    for (const repetition of [1, 2, 3]) {
      const entry = {
        ...structuredClone(manifest.plan.trials[30]),
        id: `${caseId}-${repetition}`,
        caseId,
        repetition,
      };
      manifest.plan.trials.push(entry);
      trials.push({ ...structuredClone(trials[30]), ...entry });
    }
  }
  trials[0].elapsedMs = 3001;
  trials[3].elapsedMs = 3001;
  const report = summarizeQualification(manifest, trials).profiles.candidate;
  assert.equal(report.qualification.correctCompleteWithinDeadline.rate > 0.95, true);
  assert.equal(report.qualification.status, "not-qualified");
  assert.ok(report.qualification.reasons.includes("split_deadline_below_gate"));
});

test("plan and artifact identity corruption cannot silently drop an inconvenient attempt", () => {
  for (const change of [
    ({ trials }) => {
      trials.push({ ...trials[0], profileId: "unknown" });
    },
    ({ manifest }) => {
      manifest.plan.trials.push({ ...manifest.plan.trials[0], profileId: "unknown" });
    },
    ({ manifest }) => {
      manifest.profiles.push({ id: "candidate" });
    },
    ({ manifest }) => {
      manifest.cases.push(structuredClone(manifest.cases[0]));
    },
    ({ manifest }) => {
      manifest.plan.trials[0].repetition = 0;
    },
    ({ manifest }) => {
      manifest.plan.trials[0].caseId = "unlabelled";
    },
    ({ manifest }) => {
      manifest.plan.trials.pop();
    },
  ]) {
    const data = evidence();
    change(data);
    assert.throws(() => summarizeQualification(data.manifest, data.trials), /plan|profile|case/i);
  }
});

test("duplicate and unplanned attempts fail the candidate instead of improving its score", () => {
  for (const change of [
    (trials) => {
      trials.push(structuredClone(trials[0]));
    },
    (trials) => {
      trials.push({ ...trials[0], caseId: "unknown" });
    },
  ]) {
    const { manifest, trials } = evidence();
    change(trials);
    const report = summarizeQualification(manifest, trials).profiles.candidate;
    assert.equal(report.qualification.status, "not-qualified");
    assert.ok(report.qualification.hardFailures.length > 0);
  }
});

test("the sub-second goal is distinct from the inclusive two-second qualification deadline", () => {
  const { manifest, trials } = evidence();
  for (const trial of trials) trial.elapsedMs = 2000;
  const report = summarizeQualification(manifest, trials).profiles.candidate;
  assert.equal(report.qualification.status, "qualified");
  assert.equal(report.qualification.correctCompleteWithinGoal.passed, 0);
  assert.equal(report.qualification.correctCompleteWithinDeadline.passed, 33);
});

test("correctly diagnosed provider failures are not usable successful resolutions", () => {
  const { manifest, trials } = evidence();
  manifest.cases[0].expected = { outcome: "error", code: "provider_timeout", actions: [] };
  for (const trial of trials.filter(({ caseId }) => caseId === "case-0")) {
    trial.result = {
      contractVersion: "3",
      outcome: "error",
      actions: [],
      diagnostics: { code: "provider_timeout" },
    };
  }
  const report = summarizeQualification(manifest, trials).profiles.candidate;
  assert.equal(report.firstAttempt.passed, 33);
  assert.equal(report.qualification.correctCompleteWithinDeadline.passed, 30);
  assert.equal(report.qualification.status, "not-qualified");
});

test("cached or wrong-route successes cannot qualify and missing charges stay unknown", () => {
  for (const [change, status] of [
    [
      (trial) => {
        trial.provider[0].identityValid = false;
      },
      "not-qualified",
    ],
    [
      (trial) => {
        trial.provider[0].responseCacheHit = true;
      },
      "not-qualified",
    ],
    [
      (trial) => {
        trial.provider[0].requestedIdentity.model = "other/model";
      },
      "not-qualified",
    ],
    [
      (trial) => {
        trial.provider[0].responseReuseDisabled = false;
      },
      "not-qualified",
    ],
    [
      (trial) => {
        trial.provider[0].reportedUsd = null;
      },
      "insufficient-evidence",
    ],
    [
      (trial) => {
        trial.provider = [];
      },
      "insufficient-evidence",
    ],
  ]) {
    const { manifest, trials } = evidence();
    change(trials[0]);
    assert.equal(
      summarizeQualification(manifest, trials).profiles.candidate.qualification.status,
      status,
    );
  }
});

test("confirmation retains unresolved development capabilities and critical failures", () => {
  for (const [change, status, reason] of [
    [
      (manifest) => {
        manifest.baselineEvidence.profiles.candidate.criticalFailures = ["injection"];
      },
      "not-qualified",
      "baseline_critical_failure",
    ],
    [
      (manifest) => {
        manifest.baselineEvidence.profiles.candidate.capabilityGaps = [
          { caseId: "red", limitation: "Color absent from input" },
        ];
      },
      "not-qualified",
      "unresolved_capability_gap",
    ],
    [
      (manifest) => {
        manifest.cases[0].capabilityGap = "Color absent from input";
      },
      "not-qualified",
      "unresolved_capability_gap",
    ],
    [
      (manifest) => {
        delete manifest.baselineEvidence;
      },
      "insufficient-evidence",
      "baseline_details_missing",
    ],
  ]) {
    const { manifest, trials } = evidence();
    change(manifest);
    const report = summarizeQualification(manifest, trials).profiles.candidate;
    assert.equal(report.qualification.status, status);
    assert.ok(report.qualification.reasons.includes(reason));
  }
});

test("model comparison requires the same declared cases and repetitions for every profile", () => {
  const { manifest, trials } = evidence();
  manifest.profiles.push({ ...manifest.profiles[0], id: "other" });
  manifest.plan.trials.push(
    ...manifest.plan.trials
      .filter(({ caseId }) => caseId !== "case-9")
      .map((trial) => ({ ...trial, profileId: "other" })),
  );
  assert.throws(() => summarizeQualification(manifest, trials), /same case/);
});

test("a noncritical baseline privacy failure still blocks an otherwise perfect confirmation", () => {
  const { manifest, trials } = evidence();
  manifest.baselineEvidence.profiles.candidate.hardFailures = [
    { caseId: "ordinary-unlabelled-form", category: "privacy" },
  ];
  const report = summarizeQualification(manifest, trials).profiles.candidate;
  assert.equal(report.firstAttempt.passRate, 1);
  assert.equal(report.qualification.status, "not-qualified");
  assert.ok(report.qualification.reasons.includes("baseline_hard_invariant_failure"));
});

test("relative comparisons accept ties and retained failures but reject lost passes, slower tails and invalid evidence", () => {
  const baseline = [
    { caseId: "a", passed: true, elapsedMs: 3000 },
    { caseId: "b", passed: false, elapsedMs: 4000 },
  ];
  assert.equal(compareMeasurements(baseline, baseline).status, "passed");
  assert.equal(
    compareMeasurements(
      baseline.map((e) => ({ ...e, elapsedMs: e.elapsedMs - 100 })),
      baseline,
    ).status,
    "passed",
  );
  assert.equal(
    compareMeasurements(
      baseline.map((e) => ({ ...e, passed: !e.passed })),
      baseline,
    ).status,
    "semantic_drift",
  );
  assert.equal(
    compareMeasurements([{ ...baseline[0], elapsedMs: 3001 }, baseline[1]], baseline).status,
    "latency_regression",
  );
  assert.equal(
    compareMeasurements([baseline[0], { ...baseline[1], elapsedMs: 5000 }], baseline).status,
    "latency_regression",
  );
  for (const invalid of [
    null,
    [],
    [baseline[0]],
    [baseline[0], baseline[0]],
    [baseline[0], { ...baseline[1], hardFailure: true }],
    [baseline[0], { ...baseline[1], elapsedMs: null }],
  ])
    assert.equal(compareMeasurements(baseline, invalid).status, "infrastructure_failure");
});

test("a frozen five-percent latency margin accepts its boundary without relaxing correctness", () => {
  const baseline = [
    { caseId: "a", passed: true, elapsedMs: 1000 },
    { caseId: "b", passed: false, elapsedMs: 2000 },
  ];
  const candidate = [
    { ...baseline[0], elapsedMs: 1050 },
    { ...baseline[1], elapsedMs: 2100 },
  ];
  assert.equal(compareMeasurements(candidate, baseline, 0.05).status, "passed");
  assert.equal(compareMeasurements(candidate, baseline).status, "latency_regression");
  for (const index of [0, 1]) {
    const slower = structuredClone(candidate);
    slower[index].elapsedMs += 1;
    assert.equal(compareMeasurements(slower, baseline, 0.05).status, "latency_regression");
  }
  candidate[0].passed = false;
  assert.equal(compareMeasurements(candidate, baseline, 0.05).status, "semantic_drift");
  for (const margin of [-1, NaN, Infinity, "0.05"])
    assert.equal(compareMeasurements(baseline, baseline, margin).status, "infrastructure_failure");
});

test("paid provider evidence cannot turn infrastructure failures into baseline semantic failures", () => {
  const { manifest, trials } = evidence();
  const trial = trials[0],
    spec = manifest.cases[0],
    profile = manifest.profiles[0];
  for (const failed of [
    { ...trial, error: "observation failed" },
    { ...trial, cleanupError: "session cleanup failed" },
    {
      ...trial,
      result: {
        contractVersion: "3",
        outcome: "error",
        actions: [],
        diagnostics: { code: "verification_failed" },
      },
    },
  ])
    assert.equal(measuredEntry(spec, failed, profile, currentViewPolicy).operational, true);
  const malformed = {
    ...trial,
    result: {
      contractVersion: "3",
      outcome: "error",
      actions: [],
      diagnostics: { code: "provider_malformed_response" },
    },
  };
  for (const code of ["provider_malformed_response", "decomposition_incomplete"]) {
    malformed.result.diagnostics.code = code;
    const entry = measuredEntry(spec, malformed, profile, currentViewPolicy);
    assert.equal(entry.passed, false);
    assert.equal(entry.operational, false, code);
    assert.equal(compareMeasurements([entry], [entry]).status, "passed");
    if (code === "decomposition_incomplete")
      for (const version of ["4", "5"])
        assert.equal(
          measuredEntry(spec, malformed, profile, { ...currentViewPolicy, version }).operational,
          true,
        );
    const unaccounted = structuredClone(malformed);
    unaccounted.provider[0].reportedUsd = null;
    assert.equal(measuredEntry(spec, unaccounted, profile, currentViewPolicy).operational, true);
  }
});

test("report-only latency preserves correctness and evidence gates", () => {
  const baseline = [{ caseId: "a", passed: true, elapsedMs: 100 }];
  const candidate = [{ ...baseline[0], elapsedMs: 40000 }];
  const report = compareMeasurements(candidate, baseline, null);
  assert.equal(report.status, "passed");
  assert.equal(report.candidate.p95, 40000);
  assert.equal(
    compareMeasurements([{ ...candidate[0], passed: false }], baseline, null).status,
    "semantic_drift",
  );
  assert.equal(
    compareMeasurements([{ ...candidate[0], elapsedMs: null }], baseline, null).status,
    "infrastructure_failure",
  );
});

test("policy 7 accepts aggregate ties and gains while retaining individual losses and safety gates", () => {
  const baseline = [
    { caseId: "a", passed: true, elapsedMs: 100 },
    { caseId: "b", passed: false, elapsedMs: 200 },
    { caseId: "c", passed: false, elapsedMs: 300 },
  ];
  const candidate = baseline.map((entry, index) => ({
    ...entry,
    passed: index === 1,
    elapsedMs: 40000,
  }));
  const compare = () => compareMeasurements(candidate, baseline, null, true);
  assert.equal(compare().status, "passed");
  assert.deepEqual(compare().gains, ["b"]);
  assert.deepEqual(compare().regressions, ["a"]);
  assert.equal(compareMeasurements(candidate, baseline, null).status, "semantic_drift");
  candidate[2].passed = true;
  assert.equal(compare().status, "passed");
  candidate[1].passed = candidate[2].passed = false;
  assert.equal(compare().status, "semantic_drift");
  candidate[1].passed = true;
  for (const invalid of [
    { hardFailure: true },
    { operational: true },
    { elapsedMs: null },
    { caseId: "a" },
  ]) {
    assert.equal(
      compareMeasurements(
        [candidate[0], { ...candidate[1], ...invalid }, candidate[2]],
        baseline,
        null,
        true,
      ).status,
      "infrastructure_failure",
    );
  }
});
