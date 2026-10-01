import { createHash } from "node:crypto";
import defaultPolicy from "./qualification-policy.json" with { type: "json" };
import { gradeTrial, summarize } from "./grader.mjs";

export { defaultPolicy };

const ratio = (passed, total) => ({ passed, total, rate: total ? passed / total : null });
const identity = (trial) => JSON.stringify([trial.caseId, trial.repetition ?? 1]);
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

function latency(entries) {
  const values = entries
    .map(({ trial }) => trial?.elapsedMs)
    .filter(finite)
    .sort((a, b) => a - b);
  return {
    p50: values.length ? values[Math.ceil(values.length * 0.5) - 1] : null,
    p95: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null,
    observed: values.length,
    unavailable: entries.length - values.length,
  };
}

function wilson(passed, total) {
  if (!total) return { lower: null, upper: null };
  const z = 1.959963984540054;
  const rate = passed / total;
  const denominator = 1 + z ** 2 / total;
  const center = (rate + z ** 2 / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((rate * (1 - rate) + z ** 2 / (4 * total)) / total)) / denominator;
  return {
    lower: passed === 0 ? 0 : Math.max(0, center - margin),
    upper: passed === total ? 1 : Math.min(1, center + margin),
  };
}

function assess(manifest, trials, policy) {
  const summary = summarize(manifest, trials);
  const specs = new Map(manifest.cases.map((spec) => [spec.id, spec]));
  const originals = new Map();
  for (const trial of trials) {
    if ((trial.attempt ?? 1) === 1 && !originals.has(identity(trial)))
      originals.set(identity(trial), trial);
  }
  const entries = [];
  for (let repetition = 1; repetition <= manifest.plan.repetitions; repetition++) {
    for (const caseId of manifest.plan.caseOrder) {
      const spec = specs.get(caseId);
      const trial = originals.get(identity({ caseId, repetition }));
      const grade = gradeTrial(spec, trial);
      const correct =
        grade.passed &&
        !grade.metrics.operationalError &&
        grade.metrics.processingComplete === true;
      entries.push({
        spec,
        trial,
        grade,
        correct,
        onTime: correct && finite(trial?.elapsedMs) && trial.elapsedMs <= policy.deadlineMs,
      });
    }
  }
  const rates = (group) => ({
    correctness: ratio(group.filter(({ correct }) => correct).length, group.length),
    correctCompleteWithinDeadline: ratio(group.filter(({ onTime }) => onTime).length, group.length),
  });
  const groups = Object.fromEntries(
    ["family", "split"].map((key) => [
      key,
      Object.fromEntries(
        [...new Set(entries.map(({ spec }) => spec[key] ?? "unspecified"))].map((value) => [
          value,
          rates(entries.filter(({ spec }) => (spec[key] ?? "unspecified") === value)),
        ]),
      ),
    ]),
  );
  const hardFailures = summary.failures.filter(
    (failure) =>
      policy.hardFailureCategories.includes(failure.category) &&
      (originals.has(identity(failure)) ||
        ["unplanned_trial", "duplicate_trial"].includes(failure.category)),
  );
  const reasons = [];
  const insufficient = [];
  const baseline = manifest.baselineEvidence?.profiles?.[manifest.profile.id];
  if (baseline?.criticalFailures?.length) reasons.push("baseline_critical_failure");
  if (baseline?.hardFailures?.length) reasons.push("baseline_hard_invariant_failure");
  if (baseline?.capabilityGaps?.length || entries.some(({ spec }) => spec.capabilityGap))
    reasons.push("unresolved_capability_gap");
  if (
    !baseline ||
    !Array.isArray(baseline.criticalFailures) ||
    !Array.isArray(baseline.hardFailures) ||
    !Array.isArray(baseline.capabilityGaps) ||
    !manifest.qualification?.baselineRunIds?.includes(manifest.baselineEvidence?.runId)
  )
    insufficient.push("baseline_details_missing");
  if (manifest.mode === "live") {
    const generations = new Set();
    for (const { trial } of entries) {
      if (!trial) continue;
      const calls = trial.provider?.filter((record) => record.forwarded) ?? [];
      if (calls.length !== 1) insufficient.push("provider_evidence_missing");
      for (const record of calls) {
        if (
          record.identityValid !== true ||
          record.requestedIdentity?.model !== manifest.profile.model ||
          record.requestedIdentity?.provider !== manifest.profile.provider
        )
          reasons.push("provider_identity_unverified");
        if (record.responseReuseDisabled !== true || record.responseCacheHit !== false)
          reasons.push("fresh_inference_unverified");
        const generationId = record.observedIdentity?.generationId;
        if (!generationId || generations.has(generationId))
          reasons.push("generation_identity_invalid");
        generations.add(generationId);
        if (!finite(record.reportedUsd)) insufficient.push("provider_charge_unavailable");
      }
    }
  }
  const overall = rates(entries);
  if (hardFailures.length) reasons.push("hard_invariant_failure");
  if (entries.some(({ spec, grade }) => spec.critical === true && !grade.passed))
    reasons.push("critical_case_failed");
  if (overall.correctness.rate < policy.minimumCorrectness) reasons.push("correctness_below_gate");
  if (overall.correctCompleteWithinDeadline.rate < policy.minimumCorrectCompleteWithinDeadline)
    reasons.push("deadline_below_gate");
  if (
    Object.values(groups.family).some(
      ({ correctness }) => correctness.rate < policy.minimumFamilyCorrectness,
    )
  )
    reasons.push("family_correctness_below_gate");
  if (
    policy.requiredSplits.some(
      (split) => groups.split[split]?.correctness.rate < policy.minimumCorrectness,
    )
  )
    reasons.push("split_correctness_below_gate");
  if (
    policy.requiredSplits.some(
      (split) =>
        groups.split[split]?.correctCompleteWithinDeadline.rate <
        policy.minimumCorrectCompleteWithinDeadline,
    )
  )
    reasons.push("split_deadline_below_gate");
  const heldOut = entries.filter(({ spec }) => spec.split === "held-out");
  const families = [...new Set(heldOut.map(({ spec }) => spec.family))];
  const successfulFamilies = families.filter((family) =>
    heldOut.filter(({ spec }) => spec.family === family).every(({ onTime }) => onTime),
  ).length;
  if (manifest.mode !== "live") insufficient.push("live_evidence_required");
  if (
    manifest.track === "offline-selection" ||
    entries.some(({ spec }) => spec.track === "offline-selection")
  )
    insufficient.push("browser_evidence_required");
  if (summary.missingTrials) insufficient.push("planned_trials_missing");
  if (!entries.length) insufficient.push("empty_plan");
  if (
    families.length < policy.minimumHeldOutFamilies ||
    heldOut.length < policy.minimumHeldOutTrials
  )
    insufficient.push("held_out_coverage_insufficient");
  if (policy.requiredSplits.some((split) => !groups.split[split]))
    insufficient.push("required_split_missing");
  if (
    !heldOut.some(
      ({ spec }) =>
        spec.contractVersion === "3" &&
        spec.expected.actions.filter(({ outcome }) => outcome === "found").length > 1,
    )
  )
    insufficient.push("held_out_plural_evidence_missing");
  for (const family of new Set(entries.map(({ spec }) => spec.family))) {
    if (
      new Set(entries.filter(({ spec }) => spec.family === family).map(({ spec }) => spec.split))
        .size > 1
    )
      insufficient.push("family_crosses_splits");
  }
  const metadata = manifest.qualification;
  const frozen = Date.parse(metadata?.frozenAt);
  const started = Date.parse(metadata?.heldOutStartedAt);
  if (
    metadata?.policySha256 !== createHash("sha256").update(JSON.stringify(policy)).digest("hex") ||
    !Number.isFinite(frozen) ||
    !Number.isFinite(started) ||
    frozen >= started
  )
    insufficient.push("policy_not_frozen_before_holdout");
  if (
    !Array.isArray(metadata?.baselineRunIds) ||
    !metadata.baselineRunIds.length ||
    metadata.baselineRunIds.some((id) => typeof id !== "string" || !id.trim())
  )
    insufficient.push("baseline_evidence_missing");
  return {
    ...summary,
    deadlineGroups: groups,
    correctLatencyMs: latency(entries.filter(({ correct }) => correct)),
    qualification: {
      status: reasons.length
        ? "not-qualified"
        : insufficient.length
          ? "insufficient-evidence"
          : "qualified",
      policyVersion: policy.version,
      reasons: [...new Set([...reasons, ...insufficient])],
      hardFailures,
      ...overall,
      correctCompleteWithinGoal: ratio(
        entries.filter(
          ({ correct, trial }) =>
            correct &&
            finite(trial?.elapsedMs) &&
            (policy.version === "1"
              ? trial.elapsedMs <= policy.goalMs
              : trial.elapsedMs < policy.goalMs),
        ).length,
        entries.length,
      ),
      uncertainty: {
        heldOutFamilies: families.length,
        successfulFamilies,
        interval95: wilson(successfulFamilies, families.length),
        limitation: policy.uncertainty,
      },
    },
  };
}

export function summarizeQualification(manifest, trials, policy = defaultPolicy) {
  const profileIds = new Set(manifest.profiles.map(({ id }) => id));
  const caseIds = new Set(manifest.cases.map(({ id }) => id));
  if (
    profileIds.size !== manifest.profiles.length ||
    profileIds.has(undefined) ||
    profileIds.has("")
  )
    throw new Error("Qualification profile identities must be unique and nonempty.");
  if (caseIds.size !== manifest.cases.length)
    throw new Error("Qualification case identities must be unique.");
  if ([...manifest.plan.trials, ...trials].some((trial) => !profileIds.has(trial?.profileId)))
    throw new Error("Qualification attempt references an undeclared profile.");
  if (
    manifest.plan.trials.some(
      (trial) =>
        !caseIds.has(trial.caseId) || !Number.isInteger(trial.repetition) || trial.repetition < 1,
    )
  )
    throw new Error("Qualification plan references an invalid case or repetition.");
  const sharedPlan = manifest.plan.trials
    .filter(({ profileId }) => profileId === manifest.profiles[0]?.id)
    .map(identity)
    .sort();
  const profiles = Object.fromEntries(
    manifest.profiles.map((profile) => {
      const planned = manifest.plan.trials.filter(({ profileId }) => profileId === profile.id);
      if (JSON.stringify(planned.map(identity).sort()) !== JSON.stringify(sharedPlan))
        throw new Error("Qualification profiles must use the same case and repetition plan.");
      const caseOrder = [...new Set(planned.map(({ caseId }) => caseId))];
      const repetitions = Math.max(0, ...planned.map(({ repetition }) => repetition));
      if (
        planned.length !== caseOrder.length * repetitions ||
        new Set(planned.map(identity)).size !== planned.length ||
        planned.some(({ attempt }) => attempt !== 1)
      )
        throw new Error(
          "Qualification requires a complete rectangular first-attempt plan per profile.",
        );
      const result = assess(
        { ...manifest, profile, plan: { caseOrder, repetitions } },
        trials.filter(({ profileId }) => profileId === profile.id),
        policy,
      );
      return [profile.id, result];
    }),
  );
  return {
    policy,
    profiles,
    qualifiedCandidates: Object.entries(profiles)
      .filter(([, report]) => report.qualification.status === "qualified")
      .map(([id]) => id),
    defaultActivated: false,
  };
}
