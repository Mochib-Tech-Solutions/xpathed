import { createHash } from "node:crypto";
import { gradeTrial } from "./grader.mjs";

const finite = (value) => Number.isFinite(value) && value >= 0;

export function measuredEntry(spec, trial, profile, policy) {
  const grade = gradeTrial(spec, trial);
  const calls = trial?.provider?.filter((call) => call?.forwarded === true) ?? [];
  return {
    caseId: spec.id,
    // Offline labels establish target selection only; browser completeness is unavailable.
    passed:
      grade.passed &&
      (spec.track === "offline-selection" || grade.metrics.processingComplete === true),
    elapsedMs: trial?.elapsedMs ?? null,
    hardFailure: grade.failures.some((failure) =>
      policy.hardFailureCategories.includes(failure.category),
    ),
    operational:
      !trial ||
      Boolean(trial.error) ||
      Boolean(trial.cleanupError) ||
      (grade.metrics.operationalError &&
        trial.result?.diagnostics?.code !== "provider_malformed_response" &&
        trial.result?.diagnostics?.code !== "decomposition_incomplete") ||
      !finite(trial.elapsedMs) ||
      calls.length !== 1 ||
      calls.some(
        (call) =>
          Boolean(call.error) ||
          call.identityValid !== true ||
          call.responseCacheHit !== false ||
          call.responseReuseDisabled !== true ||
          !call.observedIdentity?.generationId ||
          call.requestedIdentity?.model !== profile.model ||
          call.requestedIdentity?.provider !== profile.provider,
      ),
    generationId: calls[0]?.observedIdentity?.generationId,
  };
}

export function compareMeasurements(candidate, baseline) {
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
  if (regressions.length) reasons.push("correctness_regression");
  return {
    status: regressions.length ? "semantic_drift" : "passed",
    reasons,
    regressions,
    gains: candidate
      .filter((e) => e.passed && !baseline.find((b) => b.caseId === e.caseId).passed)
      .map((e) => e.caseId),
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
  const report = compareMeasurements(candidate, baseline);
  report.groups = {};
  for (const track of ["browser", "offline-selection"]) {
    const ids = new Set(
      manifest.cases.filter((spec) => (spec.track ?? "browser") === track).map((spec) => spec.id),
    );
    if (ids.size)
      report.groups[track] = compareMeasurements(
        candidate.filter((entry) => ids.has(entry.caseId)),
        baseline.filter((entry) => ids.has(entry.caseId)),
      );
  }
  return report;
}
