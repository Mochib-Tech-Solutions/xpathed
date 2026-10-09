import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import policy from "./policy.json" with { type: "json" };
import { gradeTrial } from "./grader.mjs";
import { summarizeQualification } from "./policy.mjs";

function evidence() {
  const cases = Array.from({ length: 11 }, (_, index) => ({
    id: `case-${index}`,
    family: `family-${index}`,
    split: index === 10 ? "regression" : "held-out",
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
            state: {
              rendered: true,
              inViewport: true,
              enabled: true,
              editable: false,
              accessibilityExposed: true,
              readonly: false,
            },
            interactability: { action: "click" },
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

function releaseEvidence() {
  const { manifest, trials: repeated } = evidence();
  const trials = repeated.filter((trial) => trial.repetition === 1);
  manifest.cases.forEach((spec) => {
    spec.split = "regression";
  });
  manifest.plan.trials = manifest.plan.trials.filter((trial) => trial.repetition === 1);
  delete manifest.baselineEvidence;
  manifest.comparison = { profile: manifest.profiles[0] };
  manifest.qualification = {
    policySha256: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
    frozenAt: "2026-10-02T12:00:00Z",
  };
  for (const trial of trials) {
    trial.baseline = structuredClone(trial);
    trial.baseline.profileId = "release-baseline";
    trial.baseline.id = createHash("sha256")
      .update(`${trial.id}:baseline`)
      .digest("hex")
      .slice(0, 32);
    trial.baseline.provider[0].observedIdentity.generationId += "-baseline";
  }
  return { manifest, trials };
}

test("complete paired regression evidence qualifies without a pilot or holdout", () => {
  const { manifest, trials } = releaseEvidence();
  const summary = summarizeQualification(manifest, trials);
  assert.deepEqual(summary.qualifiedCandidates, ["candidate"]);
});

test("regressions block release, while latency and missing charges do not", () => {
  const { manifest, trials } = releaseEvidence();
  trials[0].elapsedMs = 9000;
  trials[0].provider[0].reportedUsd = null;
  trials[0].accountingError = "ledger unavailable";
  assert.deepEqual(summarizeQualification(manifest, trials).qualifiedCandidates, ["candidate"]);
  trials[0].observation.actions[0].matches[0].intended = false;
  assert.deepEqual(summarizeQualification(manifest, trials).qualifiedCandidates, []);
});

test("missing trials, duplicate attempts, changed policy, and leaked oracle labels cannot qualify", () => {
  for (const change of [
    ({ trials }) => trials.pop(),
    ({ trials }) => trials.push(structuredClone(trials[0])),
    ({ manifest }) => (manifest.qualification.policySha256 = "changed"),
    ({ trials }) => (trials[0].observation.oracleLeak = true),
  ]) {
    const run = releaseEvidence();
    change(run);
    assert.deepEqual(summarizeQualification(run.manifest, run.trials).qualifiedCandidates, []);
  }
});

test("provider evidence errors block release while accounting warnings stay descriptive", () => {
  const { manifest, trials } = releaseEvidence();
  trials[0].provider[0].accountingWarning = "Ledger unavailable";
  assert.deepEqual(summarizeQualification(manifest, trials).qualifiedCandidates, ["candidate"]);
  for (const arm of [trials[0], trials[0].baseline]) {
    arm.provider[0].error = "Required evidence write failed";
    const summary = summarizeQualification(manifest, trials);
    assert.deepEqual(summary.qualifiedCandidates, []);
    assert.equal(
      summary.profiles.candidate.qualification.comparison.status,
      "infrastructure_failure",
    );
    delete arm.provider[0].error;
  }
});

test("fresh baseline retains the complete denominator and rejects missing or invalid provider evidence", () => {
  const fresh = () => {
    const run = releaseEvidence();
    delete run.manifest.comparison;
    run.manifest.initialBaseline = "retired-release";
    for (const trial of run.trials) delete trial.baseline;
    return run;
  };
  const run = fresh();
  run.trials[0].observation.actions[0].matches[0].intended = false;
  let result = summarizeQualification(run.manifest, run.trials);
  assert.deepEqual(result.qualifiedCandidates, ["candidate"]);
  assert.equal(
    result.profiles.candidate.qualification.comparison.candidate.total,
    run.manifest.cases.length,
  );
  assert.equal(result.profiles.candidate.qualification.comparison.baseline, undefined);
  delete run.manifest.initialBaseline;
  assert.deepEqual(summarizeQualification(run.manifest, run.trials).qualifiedCandidates, []);
  for (const change of [
    ({ trials }) => trials.pop(),
    ({ trials }) => trials.push(structuredClone(trials[0])),
    ({ trials }) => {
      trials[0].provider[0].identityValid = false;
    },
    ({ trials }) => {
      trials[0].provider[0].observedIdentity.generationId =
        trials[1].provider[0].observedIdentity.generationId;
    },
  ]) {
    const changed = fresh();
    change(changed);
    assert.deepEqual(
      summarizeQualification(changed.manifest, changed.trials).qualifiedCandidates,
      [],
    );
  }
});
