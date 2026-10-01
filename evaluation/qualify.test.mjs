import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMatrixPlan,
  parseQualificationOptions,
  selectQualificationCases,
  forecastPilot,
  readRun,
  baselineEvidence,
  assertFrozenImplementation,
  profiles,
} from "./qualify.mjs";
import { fingerprints } from "./run.mjs";

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

test("held-out calls require a recorded pilot; unsupported filters cannot silently select defaults", () => {
  assert.throws(() => parseQualificationOptions(["--split", "held-out"]), /confirmation/);
  assert.throws(() => parseQualificationOptions(["--phase", "confirmation"]), /pilot/);
  assert.throws(() => parseQualificationOptions(["--profile", "unknown"]), /profile/);
  assert.throws(() => parseQualificationOptions(["--split", "test"]), /split/);
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

test("forecast uses actual pilot token distributions at fresh prices and refuses missing charges", () => {
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
  assert.equal(result.fits, true);
  assert.equal(forecastPilot(pilot, planned, prices, { remainingUsd: 0.001 }).fits, false);
  delete pilot.trials[0].provider[0].reportedUsd;
  assert.throws(
    () => forecastPilot(pilot, planned, prices, { remainingUsd: 1 }),
    /incomplete billed/,
  );
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
  ])
    files[path] = digest(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
  const spec = JSON.parse(await readFile(new URL("./cases.json", import.meta.url), "utf8"))
    .cases[0];
  const planned = { id: "test", caseId: spec.id, profileId: "deepseek", repetition: 1, attempt: 1 };
  const manifest = {
    kind: "model-qualification",
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
  manifest.cases[0].instruction = "tampered";
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(readRun(directory), /integrity mismatch/);
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
