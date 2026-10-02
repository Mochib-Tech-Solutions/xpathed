import assert from "node:assert/strict";
import test from "node:test";
import { compareMeasurements, measuredEntry } from "./comparison.mjs";

const entry = (caseId, passed, elapsedMs = 100) => ({
  caseId,
  passed,
  elapsedMs,
  operational: false,
  hardFailure: false,
});

test("a lost baseline pass fails even when other cases improve", () => {
  const result = compareMeasurements(
    [entry("old", false), entry("new", true)],
    [entry("old", true), entry("new", false)],
  );
  assert.equal(result.status, "semantic_drift");
  assert.deepEqual(result.regressions, ["old"]);
  assert.deepEqual(result.gains, ["new"]);
});

test("latency is descriptive and a complete unchanged result passes", () => {
  assert.equal(
    compareMeasurements([entry("save", true, 9000)], [entry("save", true)]).status,
    "passed",
  );
});

test("missing cost and accounting outages do not invalidate a provider observation", () => {
  const spec = { id: "absent", expected: { outcome: "not_found", actions: [] } };
  const trial = {
    elapsedMs: 100,
    accountingError: "ledger unavailable",
    result: { outcome: "not_found", actions: [], summary: { processingComplete: true } },
    provider: [
      {
        forwarded: true,
        identityValid: true,
        responseCacheHit: false,
        responseReuseDisabled: true,
        reportedUsd: null,
        observedIdentity: { generationId: "generation-1" },
        requestedIdentity: { model: "model", provider: "provider" },
      },
    ],
  };
  const observed = measuredEntry(
    spec,
    trial,
    { model: "model", provider: "provider" },
    { hardFailureCategories: [] },
  );
  assert.equal(observed.operational, false);
  trial.provider[0].accountingWarning = "Provider accounting unavailable";
  assert.equal(
    measuredEntry(
      spec,
      trial,
      { model: "model", provider: "provider" },
      { hardFailureCategories: [] },
    ).operational,
    false,
  );
  trial.provider[0].error = "Required evidence write failed";
  assert.equal(
    measuredEntry(
      spec,
      trial,
      { model: "model", provider: "provider" },
      { hardFailureCategories: [] },
    ).operational,
    true,
  );
  delete trial.provider[0].error;
  trial.provider[0].forwarded = "true";
  assert.equal(
    measuredEntry(
      spec,
      trial,
      { model: "model", provider: "provider" },
      { hardFailureCategories: [] },
    ).operational,
    true,
  );
  trial.provider[0].forwarded = true;
  trial.provider[0].identityValid = false;
  assert.equal(
    measuredEntry(
      spec,
      trial,
      { model: "model", provider: "provider" },
      { hardFailureCategories: [] },
    ).operational,
    true,
  );
});

test("missing, duplicate, and operational results cannot pass a comparison", () => {
  for (const candidate of [
    [],
    [entry("save", true), entry("save", true)],
    [{ ...entry("save", true), operational: true }],
  ])
    assert.equal(
      compareMeasurements(candidate, [entry("save", true)]).status,
      "infrastructure_failure",
    );
});
