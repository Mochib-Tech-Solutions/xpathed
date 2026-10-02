import assert from "node:assert/strict";
import test from "node:test";
import { verifyMerge } from "./promote-pr.mjs";

test("approval accepts the tested tree across differing synthetic and final merge commits", () => {
  const receipt = {
    pr: 7,
    headSha: "a".repeat(40),
    sourceSha: "b".repeat(40),
    sourceTree: "c".repeat(40),
  };
  const pr = {
    number: 7,
    merged: true,
    merge_commit_sha: "d".repeat(40),
    head: { sha: receipt.headSha },
  };
  assert.doesNotThrow(() => verifyMerge(pr, receipt, receipt.sourceTree));
  for (const changed of [
    { ...pr, merged: false },
    { ...pr, number: 8 },
    { ...pr, head: { sha: "e".repeat(40) } },
  ])
    assert.throws(() => verifyMerge(changed, receipt, receipt.sourceTree), /differs/);
  assert.throws(() => verifyMerge(pr, receipt, "f".repeat(40)), /differs/);
  assert.throws(() => verifyMerge(pr, { ...receipt, sourceTree: undefined }, undefined), /differs/);
});
