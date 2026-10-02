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
  forecastPilot,
  readRun,
  baselineEvidence,
  assertFrozenImplementation,
  profiles,
  compatibilityCases,
  main,
  fixtureProxy,
  summarizeMonitoring,
  assertPilotReady,
  savePairedTrial,
} from "./qualify.mjs";
import currentPolicy from "./current-view-qualification-policy.json" with { type: "json" };
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

test("frozen sentinel monitoring separates semantic drift, latency and infrastructure failures", () => {
  assert.throws(
    () =>
      selectQualificationCases([{ id: "fresh", split: "held-out" }], {
        sentinelIds: ["fresh"],
        splits: ["held-out"],
        mode: "live",
      }),
    /never fresh held-out/,
  );
  const spec = {
    id: "absent",
    contractVersion: "4",
    expected: {
      outcome: "not_found",
      actions: [{ step: 1, action: "click", outcome: "not_found" }],
      summary: { processingComplete: true },
    },
  };
  const trial = {
    id: "trial",
    caseId: "absent",
    profileId: "deepseek",
    attempt: 1,
    elapsedMs: 300,
    provider: [
      { forwarded: true, identityValid: true, responseCacheHit: false, reportedUsd: 0.001 },
    ],
    result: {
      contractVersion: "4",
      action: "click",
      outcome: "not_found",
      actions: [{ actionId: "a1", order: 1, step: 1, action: "click", outcome: "not_found" }],
      summary: { processingComplete: true },
    },
  };
  const manifest = {
    monitoring: true,
    mode: "live",
    policy: { version: "3", deadlineMs: 2000, minimumCorrectCompleteWithinDeadline: 0.95 },
    cases: [spec],
    plan: { trials: [{ id: "trial", caseId: "absent", profileId: "deepseek" }] },
  };
  assert.equal(summarizeMonitoring(manifest, [trial]).status, "passed");
  assert.equal(
    summarizeMonitoring(manifest, [{ ...trial, elapsedMs: 2500 }]).status,
    "latency_regression",
  );
  assert.equal(summarizeMonitoring(manifest, []).status, "infrastructure_failure");
  assert.equal(summarizeMonitoring(manifest, []).reportedUsd, null);
  assert.equal(
    summarizeMonitoring(manifest, [{ ...trial, provider: [] }]).status,
    "infrastructure_failure",
  );
  const wrong = structuredClone(trial);
  wrong.result.actions[0].action = "hover";
  assert.equal(summarizeMonitoring(manifest, [wrong]).status, "semantic_drift");
  assert.equal(summarizeMonitoring(manifest, [trial]).defaultActivated, false);
  const pilot = { ...manifest, phase: "pilot", monitoring: false };
  assert.equal(assertPilotReady({ manifest: pilot, trials: [trial] }).status, "passed");
  for (const trials of [[], [wrong], [{ ...trial, elapsedMs: 2500 }]])
    assert.throws(() => assertPilotReady({ manifest: pilot, trials }), /Pilot failed/);
  assert.throws(() => assertPilotReady({ manifest, trials: [trial] }), /development pilot/);
  const profile = profiles.find((p) => p.id === "deepseek");
  const relative = {
    ...pilot,
    policy: currentPolicy,
    profiles: [profile],
    comparison: { profile },
  };
  trial.elapsedMs = 3000;
  Object.assign(trial.provider[0], {
    responseReuseDisabled: true,
    observedIdentity: { generationId: "candidate" },
    requestedIdentity: { model: profile.model, provider: profile.provider },
  });
  trial.baseline = structuredClone(trial);
  trial.baseline.profileId = "release-baseline";
  trial.baseline.id = createHash("sha256")
    .update(`${trial.id}:baseline`)
    .digest("hex")
    .slice(0, 32);
  trial.baseline.elapsedMs = 3500;
  trial.baseline.provider[0].observedIdentity.generationId = "baseline";
  assert.equal(assertPilotReady({ manifest: relative, trials: [trial] }).status, "passed");
  const monitoring = { ...relative, monitoring: true };
  const baseline = [{ caseId: spec.id, passed: true, elapsedMs: 3500 }];
  assert.equal(summarizeMonitoring(monitoring, [trial], baseline).status, "passed");
  const boundary = { ...trial, elapsedMs: 3675 };
  assert.equal(assertPilotReady({ manifest: relative, trials: [boundary] }).status, "passed");
  assert.equal(summarizeMonitoring(monitoring, [boundary], baseline).status, "passed");
  const historical = { ...currentPolicy, version: "4", latencyMargin: undefined };
  assert.throws(
    () => assertPilotReady({ manifest: { ...relative, policy: historical }, trials: [boundary] }),
    /Pilot failed/,
  );
  assert.equal(
    summarizeMonitoring({ ...monitoring, policy: historical }, [boundary], baseline).status,
    "latency_regression",
  );
  assert.equal(
    summarizeMonitoring(monitoring, [{ ...trial, elapsedMs: 4000 }], baseline).status,
    "passed",
  );
  const policy5 = { ...currentPolicy, version: "5", latencyMargin: 0.05 };
  assert.equal(
    summarizeMonitoring({ ...monitoring, policy: policy5 }, [boundary], baseline).status,
    "passed",
  );
  assert.equal(
    summarizeMonitoring(
      { ...monitoring, policy: policy5 },
      [{ ...trial, elapsedMs: 4000 }],
      baseline,
    ).status,
    "latency_regression",
  );
  assert.equal(
    assertPilotReady({ manifest: relative, trials: [{ ...trial, elapsedMs: 40000 }] }).status,
    "passed",
  );
  assert.equal(summarizeMonitoring(monitoring, [trial]).status, "infrastructure_failure");
  const lost = structuredClone(trial);
  lost.result.action = lost.result.actions[0].action = "hover";
  const gained = structuredClone(trial);
  gained.id += "-gain";
  gained.caseId += "-gain";
  gained.provider[0].observedIdentity.generationId = "candidate-gain";
  gained.baseline.id = createHash("sha256")
    .update(`${gained.id}:baseline`)
    .digest("hex")
    .slice(0, 32);
  gained.baseline.caseId = gained.caseId;
  gained.baseline.result.action = gained.baseline.result.actions[0].action = "hover";
  gained.baseline.provider[0].observedIdentity.generationId = "baseline-gain";
  const paired = { ...relative, cases: [spec, { ...spec, id: gained.caseId }] };
  const saved = [...baseline, { caseId: gained.caseId, passed: false, elapsedMs: 3500 }];
  const monitored = { ...paired, monitoring: true };
  assert.equal(assertPilotReady({ manifest: paired, trials: [lost, gained] }).status, "passed");
  const aggregate = summarizeMonitoring(monitored, [lost, gained], saved);
  assert.equal(aggregate.status, "passed");
  assert.deepEqual(aggregate.regressions, [spec.id]);
  assert.deepEqual(aggregate.gains, [gained.caseId]);
  const strict = { ...currentPolicy, version: "6" };
  assert.throws(
    () => assertPilotReady({ manifest: { ...paired, policy: strict }, trials: [lost, gained] }),
    /Pilot failed/,
  );
  assert.equal(
    summarizeMonitoring({ ...monitored, policy: strict }, [lost, gained], saved).status,
    "semantic_drift",
  );
});

test("qualification interleaves every profile per case and rotates first position", () => {
  const cases = [{ id: "a" }, { id: "b" }];
  const profiles = [{ id: "luna" }, { id: "gemini" }, { id: "deepseek" }];
  const options = { seed: 1, repetitions: 3, timeoutMs: 45000 };
  const plan = buildMatrixPlan(cases, profiles, options);
  assert.equal(plan.trials.length, 18);
  assert.deepEqual(plan, buildMatrixPlan(cases, profiles, options));
  for (const item of cases)
    for (let repetition = 1; repetition <= 3; repetition++)
      assert.deepEqual(
        plan.trials
          .filter((t) => t.caseId === item.id && t.repetition === repetition)
          .map((t) => t.profileId)
          .sort(),
        ["deepseek", "gemini", "luna"],
      );
  assert.equal(new Set(plan.trials.filter((_, i) => i % 3 === 0).map((t) => t.profileId)).size, 3);
  assert.equal(plan.concurrency, 1);
  assert.equal(plan.retries, 0);
});

test("the current policy sentinel launcher reaches browser preflight without paid calls", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "xpathed-sentinel-launch-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [
      "evaluation/qualify.mjs",
      "--mode",
      "live",
      "--profile",
      "deepseek",
      "--suite",
      "evaluation/current-view-qualification-cases.json",
      "--sentinels",
      "true",
      "--split",
      "development,regression",
      "--output",
      output,
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        XPATHED_BROWSER_BINARY_SHA256: "b".repeat(64),
        XPATHED_BROWSER_URL: "http://127.0.0.1:1",
        XPATHED_FIXTURE_URL: "http://127.0.0.1:1",
        XPATHED_RELEASE_COMPARISON_JSON: "",
        XPATHED_RELEASE_ARTIFACT_JSON: undefined,
      },
    },
  );
  assert.equal(result.status, 1, result.stderr);
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.monitoring, true);
  assert.equal(manifest.policy.version, currentPolicy.version);
  assert.ok(manifest.cases.every((c) => c.split !== "held-out"));
  assert.match(
    await readFile(join(output, "run-error.json"), "utf8"),
    /fetch failed|bad port|compatibility failed/,
  );
});

test("held-out calls require a recorded pilot; unsupported filters cannot silently select defaults", () => {
  assert.throws(() => parseQualificationOptions(["--split", "held-out"]), /confirmation/);
  assert.throws(() => parseQualificationOptions(["--phase", "confirmation"]), /pilot/);
  assert.throws(() => parseQualificationOptions(["--profile", "unknown"]), /profile/);
  assert.throws(() => parseQualificationOptions(["--split", "test"]), /split/);
});

test("a reviewed suite override retains current-view cases and legacy exclusions", () => {
  const options = parseQualificationOptions(["--suite", "evaluation/viewport-baseline-cases.json"]);
  assert.equal(options.suite, "evaluation/viewport-baseline-cases.json");
  const { cases, exclusions } = selectQualificationCases(
    ["2", "3", "4"].map((contractVersion) => ({
      id: `v${contractVersion}`,
      contractVersion,
      split: "development",
    })),
    options,
  );
  assert.deepEqual(
    cases.map(({ id }) => id),
    ["v3", "v4"],
  );
  assert.equal(exclusions[0].caseId, "v2");
  assert.throws(() => parseQualificationOptions(["--suite", "one", "--suite", "two"]), /Repeated/);
});

test("forecast-only preparation is explicit and cannot silently enable inference", () => {
  assert.equal(
    parseQualificationOptions(["--mode", "live", "--forecast-only", "true"]).forecastOnly,
    true,
  );
  assert.equal(parseQualificationOptions([]).forecastOnly, false);
  assert.throws(() => parseQualificationOptions(["--forecast-only", "yes"]), /forecast/);
  assert.throws(() => parseQualificationOptions(["--forecast-only", "true"]), /live/);
});

test("compatibility checks each selected contract independently before inference", () => {
  const suite = ["3", "4"].flatMap((contractVersion) =>
    ["positive", "absent", "plural"].map((kind) => ({
      id: `${kind}-${contractVersion}`,
      contractVersion,
      split: "development",
      expected: {
        actions:
          kind === "plural"
            ? [{ outcome: "found" }, { outcome: "found" }]
            : [{ outcome: kind === "positive" ? "found" : "not_found" }],
      },
    })),
  );
  assert.equal(compatibilityCases(suite).length, 6);
  assert.throws(() => compatibilityCases(suite.filter((c) => c.id !== "plural-4")), /contract 4/);
});

test("Qwen is an explicit baseline profile without changing the default matrix", () => {
  assert.deepEqual(parseQualificationOptions(["--profile", "qwen"]).profileIds, ["qwen"]);
  assert.deepEqual(parseQualificationOptions([]).profileIds, ["luna", "gemini", "deepseek"]);
  assert.deepEqual(
    profiles.find((profile) => profile.id === "qwen"),
    {
      id: "qwen",
      model: "qwen/qwen3.8-flash",
      provider: "alibaba",
      reasoning: { enabled: false },
      maxTokens: 4096,
      resolver: "http://resolver-qwen:8080",
      variant: "baseline",
    },
  );
});

test("selection records every exclusion without stripping mutation or changing splits", () => {
  const cases = [
    { id: "included", split: "development", contractVersion: "3" },
    { id: "holdout", split: "held-out", contractVersion: "3" },
    { id: "legacy", split: "development", contractVersion: "2" },
    { id: "mutation", split: "development", contractVersion: "3", mutation: {} },
    { id: "fault", split: "development", contractVersion: "3", provider: { fault: "timeout" } },
  ];
  const result = selectQualificationCases(cases, { mode: "live", splits: ["development"] });
  assert.deepEqual(
    result.cases.map((c) => c.id),
    ["included"],
  );
  assert.equal(result.exclusions.length, 4);
  assert.equal(cases[3].mutation != null, true);
  assert.equal(cases[1].split, "held-out");
});

test("forecast is informational and preserves unavailable pricing or token evidence", () => {
  const pilot = {
    trials: [
      {
        profileId: "gemini",
        provider: [
          {
            forwarded: true,
            usage: { prompt_tokens: 100, completion_tokens: 10 },
            reportedUsd: 0.001,
          },
          {
            forwarded: true,
            usage: { prompt_tokens: 300, completion_tokens: 30 },
            reportedUsd: 0.003,
          },
        ],
      },
    ],
  };
  const planned = [{ profileId: "gemini" }, { profileId: "gemini" }];
  const prices = { gemini: { prompt: 0.000001, completion: 0.000002, request: 0 } };
  const result = forecastPilot(pilot, planned, prices, { remainingUsd: 1 });
  assert.equal(result.byProfile.gemini.inputTokens.mean, 200);
  assert.equal(result.byProfile.gemini.outputTokens.p95, 30);
  assert.ok(Math.abs(result.byProfile.gemini.projectedUsd - 0.00048) < 1e-12);
  assert.ok(Math.abs(result.projectedUsd - 0.00144) < 1e-12);
  assert.equal(result.fits, null);
  assert.equal(result.budgetPolicy, "provider-limit");
  assert.equal(forecastPilot(pilot, planned, prices, { remainingUsd: 0 }).fits, null);
  delete pilot.trials[0].provider[0].reportedUsd;
  assert.equal(forecastPilot(pilot, planned, prices).projectedUsd, result.projectedUsd);
  delete pilot.trials[0].provider[0].usage;
  assert.equal(forecastPilot(pilot, planned, prices).projectedUsd, null);
  assert.match(
    forecastPilot(pilot, planned, prices).byProfile.gemini.unavailable,
    /token evidence/,
  );
  assert.equal(forecastPilot(pilot, planned, {}).projectedUsd, null);
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
    "evaluation/qualify.mjs",
    "evaluation/grader.mjs",
    "evaluation/qualification-policy.mjs",
    "evaluation/release-comparison.mjs",
  ])
    files[path] = digest(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
  const spec = JSON.parse(await readFile(new URL("./cases.json", import.meta.url), "utf8"))
    .cases[0];
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
  assert.equal(await main(["--replay", directory]), 0);
  await writeFile(
    join(directory, "trials", "test.json"),
    JSON.stringify({ ...planned, accountingError: "Final reconciliation failed" }),
  );
  assert.equal(await main(["--replay", directory]), 1);
  await writeFile(join(directory, "trials", "test.json"), JSON.stringify(planned));
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

test("qualification rejects malformed or mismatched release identity before opening services", async () => {
  const code = await fingerprints();
  for (const artifact of [
    { version: 1 },
    releaseArtifact("0".repeat(40)),
    { ...releaseArtifact(code.revision), profileId: "qwen" },
    { ...releaseArtifact(code.revision), images: releaseArtifact(code.revision).images.reverse() },
    { ...releaseArtifact(code.revision), platform: { os: "windows", architecture: "amd64" } },
  ]) {
    const result = spawnSync(
      process.execPath,
      ["evaluation/qualify.mjs", "--profile", "deepseek"],
      {
        encoding: "utf8",
        env: { ...process.env, XPATHED_RELEASE_ARTIFACT_JSON: JSON.stringify(artifact) },
      },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /artifact/i);
  }
});

test("baseline failures are regraded and capability gaps survive a fabricated passing grade", () => {
  const spec = {
    id: "red",
    critical: true,
    capabilityGap: "Color absent",
    expected: { actions: [] },
  };
  const result = baselineEvidence({
    manifest: {
      id: "pilot",
      contentHash: "digest",
      profiles: [{ id: "deepseek" }],
      cases: [spec],
      plan: { trials: [{ id: "trial", caseId: "red", profileId: "deepseek" }] },
    },
    trials: [
      {
        id: "trial",
        caseId: "red",
        profileId: "deepseek",
        grade: { passed: true },
        error: { message: "timeout" },
      },
    ],
  });
  assert.deepEqual(result.profiles.deepseek.criticalFailures, ["red"]);
  assert.deepEqual(result.profiles.deepseek.capabilityGaps, [
    { caseId: "red", limitation: "Color absent" },
  ]);
});

test("frozen implementations detect changed, added and removed runtime sources and launch configuration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "xpathed-qualification-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const path of [
    "src/Common/Resolution.cs",
    "src/Browser/Selection/Verify.cs",
    "src/Resolver/Program.cs",
    "docker/compose.qualification.yaml",
    "scripts/evaluate.sh",
    "evaluation/fixtures.mjs",
    "evaluation/server.mjs",
    "evaluation/run.mjs",
  ]) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), "original");
  }
  const initial = await fingerprints(directory);
  assertFrozenImplementation(initial, initial);
  for (const path of [
    "src/Common/Resolution.cs",
    "src/Browser/Selection/Verify.cs",
    "src/Resolver/Program.cs",
    "docker/compose.qualification.yaml",
    "scripts/evaluate.sh",
    "evaluation/fixtures.mjs",
    "evaluation/server.mjs",
    "evaluation/run.mjs",
  ]) {
    await writeFile(join(directory, path), "changed");
    const changed = await fingerprints(directory);
    assert.throws(
      () => assertFrozenImplementation(changed, initial),
      /Implementation changed after pilot/,
    );
    await writeFile(join(directory, path), "original");
  }
  await writeFile(join(directory, "src/Common/NewContract.cs"), "new");
  const added = await fingerprints(directory);
  assert.throws(
    () => assertFrozenImplementation(added, initial),
    /Implementation changed after pilot/,
  );
  await rm(join(directory, "src/Common/NewContract.cs"));
  await rm(join(directory, "src/Common/Resolution.cs"));
  const removed = await fingerprints(directory);
  assert.throws(
    () => assertFrozenImplementation(removed, initial),
    /Implementation changed after pilot/,
  );
  assert.throws(
    () =>
      assertFrozenImplementation(
        { code: initial, browserBinarySha256: "new" },
        { code: initial, browserBinarySha256: "old" },
      ),
    /Chromium binary/,
  );
  assert.throws(
    () =>
      assertFrozenImplementation(
        { code: initial, qualification: { artifact: { bundleManifestSha256: "new" } } },
        { code: initial, qualification: { artifact: { bundleManifestSha256: "old" } } },
      ),
    /artifact/i,
  );
});

test("an unflagged baseline privacy failure cannot be discarded before held-out qualification", () => {
  const result = baselineEvidence({
    manifest: {
      id: "pilot",
      contentHash: "digest",
      profiles: [{ id: "deepseek" }],
      cases: [{ id: "ordinary", expected: { actions: [] } }],
      plan: { trials: [{ id: "trial", caseId: "ordinary", profileId: "deepseek" }] },
    },
    trials: [{ id: "trial", observation: { privacyLeak: true }, grade: { passed: true } }],
  });
  assert.deepEqual(result.profiles.deepseek.criticalFailures, []);
  assert.ok(
    result.profiles.deepseek.hardFailures.some(
      (f) => f.caseId === "ordinary" && f.category === "privacy",
    ),
  );
});

test("paired baselines keep each pair adjacent and alternate which contract runs first", () => {
  const cases = ["a", "b", "c", "d"].flatMap((pairId) =>
    ["3", "4"].map((contractVersion) => ({
      id: `${pairId}-${contractVersion}`,
      pairId,
      contractVersion,
    })),
  );
  const options = { seed: 47, repetitions: 1, timeoutMs: 45000 };
  const plan = buildMatrixPlan(cases, [{ id: "deepseek" }], options);
  assert.deepEqual(plan, buildMatrixPlan(cases, [{ id: "deepseek" }], options));
  for (let index = 0; index < plan.trials.length; index += 2) {
    const pair = plan.trials
      .slice(index, index + 2)
      .map((t) => cases.find((c) => c.id === t.caseId));
    assert.equal(pair[0].pairId, pair[1].pairId);
    assert.equal(pair[0].contractVersion, index % 4 === 0 ? "3" : "4");
  }
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
