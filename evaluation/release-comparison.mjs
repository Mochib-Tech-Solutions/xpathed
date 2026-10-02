import { createHash } from "node:crypto";
import { gradeTrial } from "./grader.mjs";

const finite = (value) => Number.isFinite(value) && value >= 0;

export function measuredEntry(spec, trial, profile, policy) {
  const grade = gradeTrial(spec, trial);
  const calls = trial?.provider?.filter((call) => call.forwarded) ?? [];
  return {
    caseId: spec.id,
    passed: grade.passed && grade.metrics.processingComplete === true,
    elapsedMs: trial?.elapsedMs ?? null,
    hardFailure: grade.failures.some((failure) =>
      policy.hardFailureCategories.includes(failure.category),
    ),
    operational:
      !trial ||
      Boolean(trial.error) ||
      Boolean(trial.cleanupError) ||
      (grade.metrics.operationalError &&
        trial.result?.diagnostics?.code !== "provider_malformed_response") ||
      Boolean(trial.accountingError) ||
      !finite(trial.elapsedMs) ||
      calls.length !== 1 ||
      calls.some(
        (call) =>
          call.identityValid !== true ||
          call.responseCacheHit !== false ||
          call.responseReuseDisabled !== true ||
          !finite(call.reportedUsd) ||
          !call.observedIdentity?.generationId ||
          call.requestedIdentity?.model !== profile.model ||
          call.requestedIdentity?.provider !== profile.provider,
      ),
    generationId: calls[0]?.observedIdentity?.generationId,
  };
}

export function compareMeasurements(candidate, baseline, latencyMargin = 0) {
  const valid = (entries) =>
    Array.isArray(entries) &&
    entries.length > 0 &&
    new Set(entries.map((e) => e.caseId)).size === entries.length &&
    entries.every(
      (e) =>
        typeof e.caseId === "string" &&
        typeof e.passed === "boolean" &&
        finite(e.elapsedMs) &&
        !e.operational &&
        !e.hardFailure,
    );
  if (
    !finite(latencyMargin) ||
    latencyMargin > 1 ||
    !valid(candidate) ||
    !valid(baseline) ||
    candidate.length !== baseline.length ||
    baseline.some((e) => !candidate.some((c) => c.caseId === e.caseId))
  )
    return { status: "infrastructure_failure", reasons: ["comparison_evidence_invalid"] };
  const metrics = (entries) => {
    const times = entries.map((e) => e.elapsedMs).sort((a, b) => a - b);
    return {
      correct: entries.filter((e) => e.passed).length,
      total: entries.length,
      p50: times[Math.ceil(times.length * 0.5) - 1],
      p95: times[Math.ceil(times.length * 0.95) - 1],
    };
  };
  const before = metrics(baseline),
    after = metrics(candidate);
  const regressions = baseline
    .filter((e) => e.passed && !candidate.find((c) => c.caseId === e.caseId).passed)
    .map((e) => e.caseId);
  const reasons = [];
  if (regressions.length || after.correct < before.correct) reasons.push("correctness_regression");
  if (after.p50 > before.p50 * (1 + latencyMargin)) reasons.push("median_latency_regression");
  if (after.p95 > before.p95 * (1 + latencyMargin)) reasons.push("tail_latency_regression");
  return {
    status: reasons.includes("correctness_regression")
      ? "semantic_drift"
      : reasons.length
        ? "latency_regression"
        : "passed",
    reasons,
    regressions,
    baseline: before,
    candidate: after,
  };
}

export function compareTrials(manifest, trials, policy) {
  const baselineProfile = manifest.comparison?.profile;
  if (!baselineProfile) return { status: "infrastructure_failure", reasons: ["baseline_missing"] };
  const candidate = [],
    baseline = [],
    generations = new Set();
  for (const spec of manifest.cases) {
    const observed = trials.filter((t) => t.caseId === spec.id && t.attempt === 1);
    const trial = observed.length === 1 ? observed[0] : null;
    const profile = manifest.profile ?? manifest.profiles.find((p) => p.id === trial?.profileId);
    const current = measuredEntry(spec, trial, profile ?? {}, policy);
    const previous = measuredEntry(spec, trial?.baseline, baselineProfile, policy);
    if (
      trial?.baseline?.caseId !== spec.id ||
      trial?.baseline?.id !==
        createHash("sha256").update(`${trial?.id}:baseline`).digest("hex").slice(0, 32) ||
      trial?.baseline?.repetition !== trial?.repetition ||
      trial?.baseline?.attempt !== 1 ||
      trial?.baseline?.profileId !== "release-baseline"
    )
      previous.operational = true;
    for (const entry of [current, previous]) {
      if (generations.has(entry.generationId)) entry.operational = true;
      generations.add(entry.generationId);
    }
    candidate.push(current);
    baseline.push(previous);
  }
  if (trials.length !== manifest.cases.length)
    return { status: "infrastructure_failure", reasons: ["comparison_inventory_invalid"] };
  return compareMeasurements(candidate, baseline, policy.latencyMargin ?? 0);
}
