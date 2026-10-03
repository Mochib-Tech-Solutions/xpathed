import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  arms,
  assertParity,
  assertProviderIntegrity,
  assertCodeIdentity,
  readTrials,
  trialId,
  selectCases,
  summarize,
} from "./compare.mjs";

test("comparison uses the shared current cases and explicit plural labels", () => {
  const cases = selectCases();
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  assert.ok(cases.every((c) => !c.mutation && !c.provider.fault));
  assert.equal(selectCases("targeting-save-button-by-name")[0].cardinality, "singleton");
  assert.equal(selectCases("scope-all-approval-buttons-in-current-view")[0].cardinality, "all");
  assert.throws(() => selectCases("missing"));
});

test("summary keeps missing attempts in category denominators and exposes regressions", () => {
  const cases = [{ id: "a" }, { id: "b" }];
  const manifest = { mode: "live", cases, groups: { a: "scope", b: "state" } };
  const trials = arms.flatMap((arm) =>
    cases.map((c) => ({
      arm,
      caseId: c.id,
      grade: { passed: arm === "basic" ? c.id === "a" : c.id === "b", metrics: {} },
      provider: [{ forwarded: true, reportedUsd: null }],
    })),
  );
  const report = summarize(manifest, trials);
  assert.deepEqual(report.changes, { gained: ["b"], lost: ["a"] });
  assert.equal(report.complete, true);
  const partial = summarize(manifest, trials.slice(0, -1));
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.categories.state.stagehand, { total: 1, passed: 0 });
  assert.equal(partial.arms.stagehand.unreportedCharges, 1);
});

test("parity rejects any changed browser observation", () => {
  const baseline = {
    viewport: { width: 1279, height: 799 },
    userAgent: "chromium",
    language: "en-US",
    languages: ["en-US", "en"],
    timeZone: "UTC",
    initialState: {},
    documentChecksum: "abc",
  };
  assert.doesNotThrow(() => assertParity(baseline, structuredClone(baseline)));
  for (const key of Object.keys(baseline))
    assert.throws(() => assertParity(baseline, { ...baseline, [key]: null }), new RegExp(key));
});

test("every planned case and arm gets a distinct stable attempt identity", async () => {
  const { buildPlan } = await import("../run.mjs");
  const { trialId } = await import("./compare.mjs");
  const plan = buildPlan(selectCases(), { mode: "live", seed: 1, repetitions: 1 });
  const ids = plan.trials.flatMap((p) => arms.map((arm) => trialId(p, arm)));
  assert.equal(new Set(ids).size, plan.trials.length * arms.length);
  assert.deepEqual(
    ids,
    plan.trials.flatMap((p) => arms.map((arm) => trialId(p, arm))),
  );
});

test("provider identity and cache violations are rejected even on the final attempt", () => {
  const record = { forwarded: true, status: 200, identityValid: true, responseCacheHit: false };
  assert.doesNotThrow(() => assertProviderIntegrity({ provider: [record] }));
  for (const changed of [
    { identityValid: false },
    { identityValid: undefined },
    { responseCacheHit: true },
  ])
    assert.throws(
      () => assertProviderIntegrity({ provider: [{ ...record, ...changed }] }),
      /comparison stopped/,
    );
  assert.doesNotThrow(() =>
    assertProviderIntegrity({ provider: [{ ...record, status: 503, identityValid: false }] }),
  );
});

test("ended response-body timeouts remain failed attempts without stopping later cases", () => {
  const record = {
    id: "body-timeout",
    forwarded: true,
    status: 200,
    error: "The operation was aborted due to timeout",
    reportedUsd: null,
  };
  const trial = {
    error: { message: "Upstream response failed" },
    provider: [record],
    evidence: { provider: [{ ...record, request: { model: "expected-model" }, response: null }] },
  };
  assert.doesNotThrow(() => assertProviderIntegrity(trial));
  assert.doesNotThrow(() =>
    assertProviderIntegrity({ ...trial, error: undefined, result: { outcome: "error" } }),
  );
  assert.throws(
    () => assertProviderIntegrity({ ...trial, error: undefined, result: { outcome: "found" } }),
    /comparison stopped/,
  );
  for (const changed of [
    { identityValid: false },
    { responseCacheHit: true },
    { response: "malformed response" },
    { response: null, error: "Cannot read properties of null (reading 'usage')" },
    { observedIdentity: { model: "unexpected-model" } },
  ]) {
    const evidence = { ...trial.evidence.provider[0], ...changed };
    const { request, response, ...metadata } = evidence;
    assert.throws(
      () =>
        assertProviderIntegrity({
          ...trial,
          provider: [metadata],
          evidence: { provider: [evidence] },
        }),
      /comparison stopped/,
    );
  }
  assert.throws(
    () => assertProviderIntegrity({ ...trial, evidence: undefined }),
    /comparison stopped/,
  );
});

test("continuation freezes fixture, oracle, provider and grader code; replay checks both graders", () => {
  const files = Object.fromEntries(
    [
      "evaluation/fixtures/pages.mjs",
      "evaluation/fixtures/oracle.js",
      "evaluation/provider.mjs",
      "evaluation/configuration.mjs",
      "evaluation/run.mjs",
      "evaluation/grader.mjs",
      "evaluation/research/grade.mjs",
      "evaluation/research/compare.mjs",
    ].map((path) => [path, "original"]),
  );
  const recorded = { files };
  for (const path of Object.keys(files)) {
    const current = { files: { ...files, [path]: "changed" } };
    assert.throws(() => assertCodeIdentity(recorded, current, true), /identity mismatch/);
    if (path.endsWith("/grader.mjs") || path.endsWith("/grade.mjs"))
      assert.throws(() => assertCodeIdentity(recorded, current), /identity mismatch/);
  }
  assert.throws(
    () =>
      assertCodeIdentity(
        recorded,
        { files: { ...files, "evaluation/fixtures/new.js": "added" } },
        true,
      ),
    /identity mismatch/,
  );
});

test("replay recomputes resolver contract grades and rejects invalid saved provider identity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "engineering-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "trials"));
  const spec = selectCases("targeting-save-button-by-name")[0];
  const planned = { caseId: spec.id, repetition: 1 };
  const trial = {
    ...planned,
    id: trialId(planned, "improved"),
    arm: "improved",
    strategy: "custom",
    mode: "live",
    error: { message: "original failure" },
    contractGrade: { passed: true },
    provider: [{ forwarded: true, status: 200, identityValid: true, responseCacheHit: false }],
  };
  const path = join(directory, "trials", `${trial.id}.json`);
  const manifest = { mode: "live", plan: { trials: [planned] }, cases: [spec] };
  await writeFile(path, JSON.stringify(trial));
  assert.equal((await readTrials(directory, manifest))[0].contractGrade.passed, false);
  trial.provider[0].identityValid = false;
  await writeFile(path, JSON.stringify(trial));
  await assert.rejects(readTrials(directory, manifest), /comparison stopped/);
});
