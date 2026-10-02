import { assertLatestBaseline } from "./release-baseline.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { checkEvaluationKey, qualificationCoverage } from "./release-ci.mjs";

test("key preflight reports provider limits without imposing research money policy", async () => {
  const calls = [];
  for (const limits of [
    { limit: 15, limit_remaining: 0, limit_reset: "monthly" },
    { limit: null, limit_remaining: null, limit_reset: null },
    {},
  ]) {
    const result = await checkEvaluationKey("private-key", async (url, options) => {
      calls.push({ url, options });
      return Response.json({ data: { is_management_key: false, expires_at: null, ...limits } });
    });
    assert.equal(result.limitUsd, limits.limit ?? null);
    assert.equal(result.remainingUsd, limits.limit_remaining ?? null);
    assert.equal(result.reset, limits.limit_reset ?? null);
  }
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/key");
  assert.equal(calls[0].options.headers.Authorization, "Bearer private-key");
});

test("key preflight still rejects unusable credentials without exposing secrets", async () => {
  for (const data of [
    { is_management_key: true },
    { is_management_key: false, expires_at: "2020-01-01T00:00:00Z" },
    { is_management_key: false, expires_at: "invalid" },
    { is_management_key: "private-key", label: "private-key" },
    null,
  ]) {
    await assert.rejects(
      checkEvaluationKey("private-key", async () => Response.json({ data })),
      (error) => /key/i.test(error.message) && !error.message.includes("private-key"),
    );
  }
  await assert.rejects(
    checkEvaluationKey("", async () => {
      throw new Error("must not fetch");
    }),
    /Missing evaluation key/,
  );
  for (const fetchImpl of [
    async () => new Response("private-key", { status: 401 }),
    async () => {
      throw new Error("private-key");
    },
    async () => new Response("private-key"),
  ]) {
    await assert.rejects(
      checkEvaluationKey("private-key", fetchImpl),
      (error) =>
        /key metadata unavailable/i.test(error.message) && !error.message.includes("private-key"),
    );
  }
});

test("live release coverage blocks reused or absent holdout before any inference", async () => {
  const suite = JSON.parse(
    await readFile(new URL("../evaluation/qualification-cases.json", import.meta.url)),
  );
  const report = qualificationCoverage(suite);
  assert.equal(report.ready, false);
  assert.equal(report.heldOutCases, 0);
  assert.ok(report.blockers.some((s) => s.includes("held-out")));
  const base = suite.cases[0];
  const fresh = {
    version: "1",
    cases: [
      base,
      ...Array.from({ length: 30 }, (_, i) => ({
        ...base,
        id: `held-${i}`,
        family: `fresh-${Math.floor(i / 3)}`,
        split: "held-out",
      })),
      { ...base, id: "regression", family: "regression-family", split: "regression" },
    ],
  };
  assert.equal(qualificationCoverage(fresh).ready, true);
  const currentView = {
    ...fresh,
    cases: fresh.cases.map((c) => ({ ...c, contractVersion: "4" })),
  };
  const currentViewReport = qualificationCoverage(currentView);
  assert.equal(currentViewReport.ready, false);
  assert.ok(currentViewReport.blockers.some((s) => /current-view qualification policy/i.test(s)));
  const mixed = {
    ...fresh,
    cases: [
      ...fresh.cases,
      {
        ...base,
        id: "current-view-compatibility",
        family: "current-view-compatibility",
        contractVersion: "4",
        deterministicOnly: true,
      },
    ],
  };
  assert.equal(qualificationCoverage(mixed).ready, false);
  fresh.cases[1].previousSplit = "development";
  assert.equal(qualificationCoverage(fresh).ready, false);
  delete fresh.cases[1].previousSplit;
  fresh.cases[1].family = base.family;
  assert.throws(() => qualificationCoverage(fresh), /family cannot cross split/);
});

test("promotion compares with the latest approval or the pinned initial baseline", () => {
  const policy = { bootstrap: { sourceSha: "a".repeat(40), profileId: "deepseek" } };
  const initial = {
    approval: "none",
    artifact: { ...policy.bootstrap, bundleManifestSha256: "b".repeat(64) },
  };
  assert.doesNotThrow(() => assertLatestBaseline(initial, null, policy));
  assert.throws(
    () =>
      assertLatestBaseline(
        { ...initial, artifact: { ...initial.artifact, sourceSha: "c".repeat(40) } },
        null,
        policy,
      ),
    /baseline/,
  );
  const current = {
    candidateSha256: "d".repeat(64),
    sourceSha: "e".repeat(40),
    profile: "gemini",
    bundleSha256: "f".repeat(64),
  };
  const reference = {
    approval: current.candidateSha256,
    artifact: {
      sourceSha: current.sourceSha,
      profileId: current.profile,
      bundleManifestSha256: current.bundleSha256,
    },
  };
  assert.doesNotThrow(() => assertLatestBaseline(reference, current, policy));
  assert.throws(() => assertLatestBaseline(initial, current, policy), /baseline/);
  assert.throws(
    () => assertLatestBaseline(reference, { ...current, candidateSha256: "a".repeat(64) }, policy),
    /baseline/,
  );
});
