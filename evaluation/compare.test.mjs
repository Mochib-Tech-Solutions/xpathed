import { loadCases } from "./cases/load.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  buildMatrixPlan,
  parseQualificationOptions,
  selectQualificationCases,
  readRun,
  profiles,
  fixtureProxy,
  summarizeMonitoring,
  savePairedTrial,
  validateReleaseArtifact,
} from "./compare.mjs";
import currentPolicy from "./policy.json" with { type: "json" };
import { fingerprints } from "./run.mjs";

const releaseArtifact = (sourceSha) => ({
  version: 1,
  bundleManifestSha256: "b".repeat(64),
  sourceSha,
  profileId: "deepseek",
  platform: { os: "linux", architecture: "amd64" },
  images: ["browser", "resolver"].map((component, index) => ({
    component,
    id: `sha256:${String(index + 1).repeat(64)}`,
    os: "linux",
    architecture: "amd64",
    sourceSha,
  })),
});

test("qualification preparation does not supply synthetic prices to the Resolver cache", async (t) => {
  let calls = 0;
  const upstream = createServer((req, res) => {
    calls++;
    res.end("{}");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = fixtureProxy(`http://127.0.0.1:${upstream.address().port}`, 1000);
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => {
    proxy.closeAllConnections();
    proxy.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  assert.equal((await fetch(`${base}/api/v1/models/example/model/endpoints`)).status, 404);
  assert.equal(calls, 0);
  assert.equal(
    (await fetch(`${base}/api/v1/chat/completions`, { method: "POST", body: "{}" })).status,
    200,
  );
  assert.equal(calls, 1);
});

test("replay preserves absent planned attempts and rejects swapped trial identities", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "xpathed-qualification-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "trials"));
  const digest = (value) =>
    createHash("sha256")
      .update(typeof value === "string" ? value : JSON.stringify(value))
      .digest("hex");
  const files = {};
  for (const path of [
    "evaluation/compare.mjs",
    "evaluation/grader.mjs",
    "evaluation/policy.mjs",
    "evaluation/comparison.mjs",
  ])
    files[path] = digest(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
  const spec = loadCases().cases[0];
  const planned = { id: "test", caseId: spec.id, profileId: "deepseek", repetition: 1, attempt: 1 };
  const manifest = {
    kind: "model-qualification",
    profiles: [{ id: "deepseek" }],
    cases: [spec],
    plan: { trials: [planned] },
    code: { files },
  };
  manifest.contentHash = digest(manifest);
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  assert.equal((await readRun(directory)).trials.length, 0);
  await writeFile(
    join(directory, "trials", "test.json"),
    JSON.stringify({ ...planned, profileId: "gemini" }),
  );
  await assert.rejects(readRun(directory), /identity mismatch/);
  await writeFile(join(directory, "trials", "test.json"), JSON.stringify(planned));
  assert.equal((await readRun(directory)).trials.length, 1);
  manifest.code.revision = "a".repeat(40);
  manifest.profiles = [{ id: "deepseek" }];
  const artifact = releaseArtifact(manifest.code.revision);
  manifest.qualification = { artifact };
  delete manifest.contentHash;
  manifest.contentHash = digest(manifest);
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  assert.deepEqual((await readRun(directory)).manifest.qualification.artifact, artifact);
  manifest.qualification = { artifact: { version: 1 } };
  delete manifest.contentHash;
  manifest.contentHash = digest(manifest);
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(readRun(directory), /artifact/i);
  delete manifest.qualification;
  manifest.cases[0].instruction = "tampered";
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(readRun(directory), /integrity mismatch/);
});

test("a baseline reservation failure retains the completed candidate and partial baseline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "xpathed-paired-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trial = { id: "candidate", result: { outcome: "found" }, observation: { preserved: true } };
  await assert.rejects(
    () =>
      savePairedTrial(directory, trial, async (retain) => {
        const first = JSON.parse(await readFile(join(directory, "candidate.json"), "utf8"));
        assert.deepEqual(first, trial);
        await retain({ id: "baseline", result: null });
        throw new Error("reservation unavailable");
      }),
    /reservation unavailable/,
  );
  const saved = JSON.parse(await readFile(join(directory, "candidate.json"), "utf8"));
  assert.deepEqual(saved.observation, { preserved: true });
  assert.deepEqual(saved.baseline, { id: "baseline", result: null });
});

test("a changed prepared input is retained without starting the paired baseline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "xpathed-rejected-preparation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trial = {
    id: "candidate",
    error: { code: "unreviewed_prepared_input" },
    evidence: { modelInput: "retained" },
  };
  await savePairedTrial(directory, trial, () => assert.fail("Baseline inference must not start"));
  assert.deepEqual(JSON.parse(await readFile(join(directory, "candidate.json"), "utf8")), trial);
});

test("release selection reuses every reviewed current case without a phase or split gate", () => {
  const options = parseQualificationOptions([]);
  assert.deepEqual(options.profileIds, ["deepseek"]);
  for (const args of [
    ["--phase", "pilot"],
    ["--pilot", "previous"],
    ["--split", "held-out"],
    ["--repetitions", "2"],
  ])
    assert.throws(() => parseQualificationOptions(args));
  const cases = [
    { id: "new", split: "held-out" },
    { id: "regression", split: "regression" },
    {
      id: "offline",
      track: "offline-selection",
      instruction: "Find Save",
      input: { instruction: "Find Save", candidates: [{ id: "c1" }] },
      expected: { actions: [{ outcome: "found", target: { candidateId: "c1" } }] },
    },
    { id: "mutation", mutation: {} },
    { id: "fault", provider: { fault: "timeout" } },
  ];
  const offline = cases.find((item) => item.id === "offline");
  offline.labelReview = {
    caseId: offline.id,
    inputHash: createHash("sha256").update(JSON.stringify(offline.input)).digest("hex"),
    labelHash: createHash("sha256").update(JSON.stringify(offline.expected)).digest("hex"),
    preparedInputHash: createHash("sha256").update(JSON.stringify(offline.input)).digest("hex"),
    disposition: "validated",
    reason: "Source target verified.",
    reviewer: "fixture-review",
    reviewedAt: "2026-10-03T00:00:00Z",
  };
  const quarantined = {
    ...offline,
    labelReview: {
      ...offline.labelReview,
      disposition: "ambiguous",
      reason: "Two equally matching targets.",
    },
  };
  assert.match(
    selectQualificationCases([cases[0], quarantined]).exclusions[0].reason,
    /label ambiguous/,
  );
  assert.throws(
    () => selectQualificationCases([{ ...offline, labelReview: undefined }]),
    /label review/,
  );
  const selected = selectQualificationCases(cases, options);
  assert.deepEqual(
    selected.cases.map((c) => c.id),
    ["new", "regression", "offline"],
  );
  assert.equal(selected.exclusions.length, 2);
  const sourceExclusions = [
    { caseId: "removed-source", reason: "label incorrect: Contradicts the instruction." },
  ];
  const filtered = selectQualificationCases(
    cases,
    { ...options, caseId: "offline" },
    sourceExclusions,
  );
  assert.equal(filtered.sourceCases, 6);
  assert.equal(filtered.cases.length, 1);
  assert.equal(filtered.exclusions.length, 5);
  assert.deepEqual(filtered.exclusions[0], sourceExclusions[0]);
  assert.deepEqual(sourceExclusions, [
    { caseId: "removed-source", reason: "label incorrect: Contradicts the instruction." },
  ]);
  const plan = buildMatrixPlan(selected.cases, [{ id: "candidate" }], options);
  assert.equal(plan.trials.length, 3);
  assert.equal(plan.retries, 0);
});
test("artifact identities must bind both components to the tested source and profile", () => {
  const sha = "a".repeat(40),
    artifact = releaseArtifact(sha);
  assert.equal(validateReleaseArtifact(artifact, sha, ["deepseek"]), artifact);
  for (const broken of [
    { ...artifact, sourceSha: "b".repeat(40) },
    { ...artifact, images: artifact.images.slice(0, 1) },
    { ...artifact, profileId: "unknown" },
  ])
    assert.throws(() => validateReleaseArtifact(broken, sha, ["deepseek"]));
});

test("nightly requires independent live generation IDs without matching the saved reference IDs", () => {
  const cases = ["one", "two"].map((id) => ({
    id,
    expected: {
      outcome: "not_found",
      actions: [{ step: 1, action: "click", outcome: "not_found" }],
    },
  }));
  const profile = { model: "model", provider: "provider" };
  const manifest = {
    monitoring: true,
    mode: "live",
    cases,
    profiles: [profile],
    policy: { hardFailureCategories: [] },
  };
  const trials = cases.map((spec, index) => ({
    caseId: spec.id,
    elapsedMs: 100,
    result: {
      action: "click",
      outcome: "not_found",
      actions: [{ step: 1, order: 1, actionId: "a1", action: "click", outcome: "not_found" }],
      summary: { processingComplete: true },
    },
    provider: [
      {
        forwarded: true,
        identityValid: true,
        responseCacheHit: false,
        responseReuseDisabled: true,
        observedIdentity: { generationId: `new-${index}` },
        requestedIdentity: profile,
      },
    ],
  }));
  const baseline = cases.map((spec, index) => ({
    caseId: spec.id,
    passed: true,
    elapsedMs: 100,
    operational: false,
    hardFailure: false,
    generationId: `old-${index}`,
  }));
  assert.equal(summarizeMonitoring(manifest, trials, baseline).status, "passed");
  for (const invalid of ["new-0", "", " ", null]) {
    const changed = structuredClone(trials);
    changed[1].provider[0].observedIdentity.generationId = invalid;
    const result = summarizeMonitoring(manifest, changed, baseline);
    assert.equal(result.status, "infrastructure_failure");
    assert.equal(result.entries[1].operational, true);
  }
});

test("direct release comparison rejects parallel execution metadata", () => {
  assert.throws(
    () => parseQualificationOptions(["--concurrency", "2"]),
    /Comparison requires concurrency 1/,
  );
});

test("live runner accepts only the explicit initial baseline before loading the complete suite", async (t) => {
  const { main } = await import("./compare.mjs");
  const { retiredReleaseCommit } = await import("./release-transition.mjs");
  const names = [
    "XPATHED_INITIAL_BASELINE",
    "XPATHED_RELEASE_COMPARISON_JSON",
    "XPATHED_RELEASE_ARTIFACT_JSON",
  ];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
  });
  for (const name of names) delete process.env[name];
  await assert.rejects(
    main(["--mode", "live", "--suite", "/missing-release-test-suite"]),
    /baseline images/,
  );
  process.env.XPATHED_INITIAL_BASELINE = "arbitrary";
  await assert.rejects(main(["--mode", "live"]), /Invalid initial baseline/);
  process.env.XPATHED_INITIAL_BASELINE = retiredReleaseCommit;
  await assert.rejects(
    main(["--mode", "live", "--suite", "/missing-release-test-suite"]),
    /ENOENT/,
  );
  await assert.rejects(
    main(["--mode", "live", "--monitoring", "true"]),
    /Invalid initial baseline/,
  );
});
