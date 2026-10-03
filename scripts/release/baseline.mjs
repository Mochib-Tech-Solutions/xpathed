import { execFileSync } from "node:child_process";
import { downloadRelease } from "./download.mjs";

import { retiredReleaseCommit } from "../../evaluation/release-transition.mjs";
export { retiredReleaseCommit };
export function assertLatestBaseline(comparison, commit) {
  if (!/^[a-f\d]{40}$/.test(commit ?? "") || comparison?.commit !== commit)
    throw new Error("Release branch changed; rerun against its current commit");
}
export function assertSameSourceTree(commit, testedCommit) {
  if (![commit, testedCommit].every((sha) => /^[a-f\d]{40}$/.test(sha ?? "")))
    throw new Error("Exact release and tested commits are required");
  const tree = (sha) =>
    execFileSync("git", ["rev-parse", `${sha}^{tree}`], { encoding: "utf8" }).trim();
  if (tree(commit) !== tree(testedCommit))
    throw new Error("Published image source differs from the release tree");
}
export async function prepareBaseline(repository, commit, destination) {
  if (commit === retiredReleaseCommit) return null;
  const downloaded = await downloadRelease(repository, commit, destination);
  assertSameSourceTree(commit, downloaded.manifest.sourceSha);
  return { bundle: downloaded.directory, digest: downloaded.receipt.bundleSha256, commit };
}
