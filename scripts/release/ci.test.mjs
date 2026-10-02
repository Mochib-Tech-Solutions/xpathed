import { loadCases } from "../../evaluation/cases/load.mjs";
import { assertLatestBaseline } from "./baseline.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { qualificationCoverage, requireCI, trustedReleasePR, caseChanges } from "./ci.mjs";

test("release coverage reuses reviewed cases and promotion requires the current baseline", () => {
  const suite = loadCases();
  assert.equal(qualificationCoverage(suite).ready, true);
  suite.cases.find((spec) => spec.contractVersion === "4").review.status = "pending";
  assert.equal(qualificationCoverage(suite).ready, false);
  const current = {
    candidateSha256: "a".repeat(64),
    sourceSha: "b".repeat(40),
    profile: "deepseek",
    bundleSha256: "c".repeat(64),
  };
  const comparison = {
    approval: current.candidateSha256,
    artifact: {
      sourceSha: current.sourceSha,
      profileId: current.profile,
      bundleManifestSha256: current.bundleSha256,
    },
  };
  assert.doesNotThrow(() => assertLatestBaseline(comparison, current));
  assert.throws(() =>
    assertLatestBaseline(comparison, { ...current, candidateSha256: "d".repeat(64) }),
  );
  assert.throws(() => assertLatestBaseline(comparison, null));
});

test("only private same-repository main to release PRs can use paid evaluation", () => {
  const repository = "owner/repo";
  const event = {
    repository: { private: true },
    pull_request: {
      base: { ref: "release", repo: { full_name: repository } },
      head: { ref: "main", repo: { full_name: repository } },
    },
  };
  assert.equal(trustedReleasePR(event, repository), true);
  for (const edit of [
    (e) => (e.repository.private = false),
    (e) => (e.pull_request.head.repo.full_name = "fork/repo"),
    (e) => (e.pull_request.head.ref = "feature"),
    (e) => (e.pull_request.base.ref = "main"),
  ]) {
    const changed = structuredClone(event);
    edit(changed);
    assert.equal(trustedReleasePR(changed, repository), false);
  }
});

test("release requires the latest ordinary CI decision on the exact tested revision", async () => {
  const sha = "a".repeat(40),
    repository = "owner/repo";
  const good = {
    id: 1,
    name: "check",
    app: { slug: "github-actions" },
    status: "completed",
    conclusion: "success",
  };
  const api = (checks) => (path) => {
    assert.equal(path, `repos/${repository}/commits/${sha}/check-runs?per_page=100`);
    return { check_runs: checks };
  };
  await requireCI(repository, sha, 0, api([good]));
  for (const checks of [
    [],
    [{ ...good, app: { slug: "other" } }],
    [good, { ...good, id: 2, conclusion: "failure" }],
    [good, { ...good, id: 2, status: "in_progress", conclusion: null }],
  ])
    await assert.rejects(requireCI(repository, sha, 0, api(checks)), /Ordinary CI/);
});

test("case changes report additions, removals and changed assertions without counting review metadata", () => {
  const old = [
    {
      id: "same",
      instruction: "Save",
      expected: { outcome: "found" },
      review: { reviewer: "first" },
    },
    { id: "changed", input: { instruction: "old" } },
    { id: "removed" },
  ];
  const current = [
    { ...old[0], review: { reviewer: "second" } },
    { id: "changed", input: { instruction: "new" } },
    { id: "added" },
  ];
  assert.deepEqual(caseChanges(old, current), {
    added: ["added"],
    removed: ["removed"],
    changed: ["changed"],
  });
});
