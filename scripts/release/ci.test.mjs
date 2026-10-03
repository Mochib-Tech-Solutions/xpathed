import { loadCases } from "../../evaluation/cases/load.mjs";
import { assertLatestBaseline } from "./baseline.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { qualificationCoverage, requireCI, trustedReleasePR, caseChanges } from "./ci.mjs";

test("release coverage reuses reviewed cases and comparison requires the current baseline", () => {
  const suite = loadCases();
  assert.equal(qualificationCoverage(suite).ready, true);
  const exclusions = [
    { caseId: "excluded-source", reason: "label ambiguous: Two controls match." },
  ];
  const coverage = qualificationCoverage(suite, exclusions);
  assert.equal(coverage.sourceCases, suite.cases.length + 1);
  assert.deepEqual(coverage.exclusions[0], exclusions[0]);
  assert.equal(coverage.sourceCases, coverage.cases + coverage.exclusions.length);
  suite.cases[0].review.status = "pending";
  assert.equal(qualificationCoverage(suite).ready, false);
  const commit = "b".repeat(40);
  const comparison = { commit, artifact: { sourceSha: commit } };
  assert.doesNotThrow(() => assertLatestBaseline(comparison, commit));
  assert.throws(() => assertLatestBaseline(comparison, "c".repeat(40)));
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

test("release verifies the latest PR CI receipt for the exact merge source and run", async () => {
  const identity = { sourceSha: "a".repeat(40), headSha: "b".repeat(40), pr: 87 };
  const repository = "owner/repo";
  const good = {
    id: 1,
    run_attempt: 2,
    pull_requests: [{ number: 87 }],
    status: "completed",
    conclusion: "success",
  };
  const gate = { passed: true, sha: identity.sourceSha, runId: "1", runAttempt: "2" };
  const api = (runs) => (path) => {
    assert.equal(
      path,
      `repos/${repository}/actions/workflows/check.yml/runs?event=pull_request&head_sha=${identity.headSha}&per_page=100`,
    );
    return { workflow_runs: runs };
  };
  await requireCI(repository, identity, 0, api([good]), async (repo, run) => {
    assert.equal(repo, repository);
    assert.deepEqual(run, good);
    return gate;
  });
  for (const runs of [
    [],
    [{ ...good, pull_requests: [{ number: 88 }] }],
    [good, { ...good, id: 2, conclusion: "failure" }],
    [good, { ...good, id: 2, status: "in_progress", conclusion: null }],
  ])
    await assert.rejects(
      requireCI(repository, identity, 0, api(runs), async () => gate),
      /Ordinary CI/,
    );
  for (const change of [
    { passed: false },
    { sha: identity.headSha },
    { runId: "2" },
    { runAttempt: "1" },
  ])
    await assert.rejects(
      requireCI(repository, identity, 0, api([good]), async () => ({ ...gate, ...change })),
      /Ordinary CI receipt/,
    );
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
