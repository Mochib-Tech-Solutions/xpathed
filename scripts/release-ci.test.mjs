import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { checkKeyBudget, qualificationCoverage } from "./release-ci.mjs";

test("key preflight accepts only a bounded non-resetting inference key within the remaining campaign", async () => {
  const calls = [];
  const data = {
    is_management_key: false,
    limit: 2.97,
    limit_remaining: 2.97,
    limit_reset: null,
    expires_at: null,
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return Response.json({ data });
  };
  assert.deepEqual(await checkKeyBudget("private-key", 2.97226, fetchImpl), {
    limitUsd: 2.97,
    remainingUsd: 2.97,
    reset: null,
    expiresAt: null,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/key");
  assert.equal(calls[0].options.headers.Authorization, "Bearer private-key");
  for (const patch of [
    { limit: null },
    { limit_reset: "monthly" },
    { limit_reset: undefined },
    { is_management_key: true },
    { limit_remaining: 3 },
    { limit_remaining: -1 },
    { expires_at: "2020-01-01T00:00:00Z" },
  ]) {
    await assert.rejects(
      checkKeyBudget("private-key", 2.97226, async () =>
        Response.json({ data: { ...data, ...patch } }),
      ),
      /key/i,
    );
  }
  await assert.rejects(
    checkKeyBudget(
      "private-key",
      2.97226,
      async () => new Response("private-key", { status: 401 }),
    ),
    /key metadata unavailable/,
  );
  await assert.rejects(
    checkKeyBudget("private-key", 2.97226, async () =>
      Response.json({
        data: { ...data, limit: null, label: "private-key", is_management_key: "private-key" },
      }),
    ),
    (error) =>
      error.message.includes('"limitUsd":"unavailable"') && !error.message.includes("private-key"),
  );
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
  fresh.cases[1].previousSplit = "development";
  assert.equal(qualificationCoverage(fresh).ready, false);
  delete fresh.cases[1].previousSplit;
  fresh.cases[1].family = base.family;
  assert.throws(() => qualificationCoverage(fresh), /family cannot cross split/);
});
