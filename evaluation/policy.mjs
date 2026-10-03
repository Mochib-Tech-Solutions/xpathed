import { createHash } from "node:crypto";
import defaultPolicy from "./policy.json" with { type: "json" };
import { compareTrials, measuredEntry } from "./comparison.mjs";
import { summarize } from "./grader.mjs";

export { defaultPolicy };
export function policyForSuite() {
  return defaultPolicy;
}
const ratio = (passed, total) => ({ passed, total, rate: total ? passed / total : null });

export function summarizeQualification(manifest, trials, policy = defaultPolicy) {
  const ids = manifest.cases.map((spec) => spec.id);
  const profileIds = manifest.profiles.map((profile) => profile.id);
  if (new Set(ids).size !== ids.length || new Set(profileIds).size !== profileIds.length)
    throw new Error("Evaluation case and profile identities must be unique");
  if ([...manifest.plan.trials, ...trials].some((trial) => !profileIds.includes(trial.profileId)))
    throw new Error("Evaluation attempt references an undeclared profile");
  const reports = Object.fromEntries(
    manifest.profiles.map((profile) => {
      const planned = manifest.plan.trials.filter((trial) => trial.profileId === profile.id);
      const observed = trials.filter((trial) => trial.profileId === profile.id);
      const validPlan =
        planned.length === ids.length &&
        new Set(planned.map((trial) => trial.caseId)).size === ids.length &&
        planned.every(
          (trial) => ids.includes(trial.caseId) && trial.repetition === 1 && trial.attempt === 1,
        );
      const plannedManifest = { ...manifest, profile, plan: { caseOrder: ids, repetitions: 1 } };
      const summary = summarize(plannedManifest, observed);
      const comparison = compareTrials(plannedManifest, observed, policy);
      const reasons = [...comparison.reasons];
      if (!validPlan) reasons.push("invalid_trial_plan");
      if (manifest.mode !== "live") reasons.push("live_evidence_required");
      if (manifest.monitoring) reasons.push("monitoring_not_release_qualification");
      if (
        manifest.qualification?.policySha256 !==
        createHash("sha256").update(JSON.stringify(policy)).digest("hex")
      )
        reasons.push("policy_identity_mismatch");
      if (!Number.isFinite(Date.parse(manifest.qualification?.frozenAt)))
        reasons.push("policy_not_frozen");
      if (
        observed.some(
          (trial) =>
            !planned.some((entry) =>
              ["id", "caseId", "profileId", "repetition", "attempt"].every(
                (key) => entry[key] === trial[key],
              ),
            ),
        )
      )
        reasons.push("unplanned_trial");
      const hardFailures = summary.failures.filter((failure) =>
        policy.hardFailureCategories.includes(failure.category),
      );
      if (hardFailures.length) reasons.push("hard_invariant_failure");
      const records = manifest.cases.map((spec) => {
        const trial = observed.find((trial) => trial.caseId === spec.id && trial.attempt === 1);
        return { spec, trial, correct: measuredEntry(spec, trial, profile, policy).passed };
      });
      const groups = Object.fromEntries(
        ["browser", "offline-selection"].map((track) => {
          const selected = records.filter(({ spec }) => (spec.track ?? "browser") === track);
          return [
            track,
            ratio(selected.filter((record) => record.correct).length, selected.length),
          ];
        }),
      );
      return [
        profile.id,
        {
          ...summary,
          qualification: {
            status: reasons.length ? "not-qualified" : "qualified",
            reasons: [...new Set(reasons)],
            hardFailures,
            comparison,
            correctness: ratio(records.filter((record) => record.correct).length, records.length),
            groups,
            correctCompleteWithinGoal: ratio(
              records.filter(
                ({ trial, correct }) =>
                  correct && Number.isFinite(trial?.elapsedMs) && trial.elapsedMs < policy.goalMs,
              ).length,
              records.length,
            ),
            correctCompleteWithinDeadline: ratio(
              records.filter(
                ({ trial, correct }) =>
                  correct &&
                  Number.isFinite(trial?.elapsedMs) &&
                  trial.elapsedMs <= policy.deadlineMs,
              ).length,
              records.length,
            ),
          },
        },
      ];
    }),
  );
  return {
    policy,
    profiles: reports,
    qualifiedCandidates: Object.entries(reports)
      .filter(([, report]) => report.qualification.status === "qualified")
      .map(([id]) => id),
  };
}
