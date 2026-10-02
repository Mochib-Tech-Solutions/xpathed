import { join } from "node:path";
import { selectQualificationCases } from "../../evaluation/compare.mjs";
import { fetchApprovedRelease } from "./fetch.mjs";

export async function prepareBaseline(snapshot, destination) {
  if (!snapshot.state.current)
    throw new Error("No approved baseline; restore the existing approval before comparison");
  const staged = await fetchApprovedRelease(snapshot, destination);
  return {
    bundle: join(staged.source, staged.candidate.bundle),
    digest: staged.candidate.bundleSha256,
    approval: snapshot.state.current.candidateSha256,
    cases: selectQualificationCases(staged.cases).cases,
  };
}
export function assertLatestBaseline(comparison, current) {
  if (
    !current ||
    comparison?.approval !== current.candidateSha256 ||
    comparison.artifact?.sourceSha !== current.sourceSha ||
    comparison.artifact.profileId !== current.profile ||
    comparison.artifact.bundleManifestSha256 !== current.bundleSha256
  )
    throw new Error(
      "Comparison baseline differs from the current approved release; rerun evaluation",
    );
}
