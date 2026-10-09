import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  cpSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { gradeTrial } from "../../evaluation/grader.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");
async function workspace(t, { qualificationPolicy = "current", bootstrapBaseline = false } = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "xpathed-release-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  cpSync("evaluation", join(cwd, "evaluation"), { recursive: true });
  mkdirSync(join(cwd, "scripts/release"), { recursive: true });
  for (const name of ["evidence", "baseline", "download"])
    cpSync(`scripts/release/${name}.mjs`, join(cwd, `scripts/release/${name}.mjs`));
  cpSync("scripts/release/bundle.mjs", join(cwd, "scripts/release/bundle.mjs"));
  cpSync("scripts/release/archive.mjs", join(cwd, "scripts/release/archive.mjs"));
  writeFileSync(join(cwd, ".gitignore"), ".artifacts/\n");
  const write = (path, value) =>
    writeFileSync(join(cwd, path), JSON.stringify(value, null, 2) + "\n");
  const now = Date.now();
  const time = (offset) => new Date(now + offset).toISOString();
  const cases = Array.from({ length: 34 }, (_, i) => ({
    id: `case-${i}`,
    family: `family-${i}`,
    split: "regression",
    instruction: "Click the labelled buttons",
    fixture: "synthetic",
    ...(i === 30 ? { deterministicOnly: true } : {}),
    review: { status: "reviewed", reviewer: "synthetic", reviewedAt: time(-5000) },
    category: "target",
    viewport: { width: 1280, height: 800 },
    expected: {
      outcome: i === 32 ? "not_found" : "found",
      actions: ([0, 33].includes(i) ? [1, 2] : [1]).map((step) => ({
        step,
        action: "click",
        outcome: i === 32 ? "not_found" : "found",
        ...(i === 32 ? {} : { target: { selector: `#button-${step}` } }),
      })),
      summary: { processingComplete: true },
    },
  }));
  const suite = { version: "1", ...(qualificationPolicy ? { qualificationPolicy } : {}), cases };
  if (qualificationPolicy) suite.sentinels = ["case-31", "case-30"];
  const suitePath = qualificationPolicy
    ? "evaluation/cases/index.json"
    : "evaluation/cases/index.json";
  write(suitePath, suite);
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Release test",
    "-c",
    "user.email=release@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Synthetic source",
  );
  const sha = git("rev-parse", "HEAD");
  const { fingerprints, configurationRecord } = await import(`file://${cwd}/evaluation/run.mjs`);
  const { profiles, selectQualificationCases } = await import(
    `file://${cwd}/evaluation/compare.mjs`
  );
  const { policyForSuite, summarizeQualification } = await import(
    `file://${cwd}/evaluation/policy.mjs`
  );
  const defaultPolicy = policyForSuite(suite);
  const profile = profiles.find((item) => item.id === "configured");
  const code = await fingerprints(cwd);
  const build = (phase, pilot) => {
    const selected = selectQualificationCases(cases, {
      mode: "live",
      splits: phase === "pilot" ? ["development"] : defaultPolicy.requiredSplits,
    });
    const path = `.artifacts/${phase}`;
    mkdirSync(join(cwd, path, "trials"), { recursive: true });
    const manifest = {
      version: "1",
      kind: "model-qualification",
      id: `${phase}-run`,
      createdAt: time(-4000),
      mode: "live",
      phase,
      ...selected,
      sourceManifestHash: hash(suite),
      profiles: [profile],
      ...(qualificationPolicy ? { comparison: { profile } } : {}),
      plan: {
        repetitions: 1,
        caseOrder: selected.cases.map((s) => s.id),
        trials: selected.cases.map((s, i) => ({
          id: hash(`${phase}-${i}`).slice(0, 32),
          caseId: s.id,
          profileId: profile.id,
          repetition: 1,
          attempt: 1,
        })),
      },
      code,
      browserBinarySha256: "b".repeat(64),
      policy: defaultPolicy,
      ...(defaultPolicy.latencyProtocol
        ? { measurement: { latencyProtocol: defaultPolicy.latencyProtocol } }
        : {}),
      qualification: {
        policySha256: hash(defaultPolicy),
        frozenAt: time(-3000),
        heldOutStartedAt: phase === "pilot" ? null : time(-2000),
        baselineRunIds: pilot ? [pilot.manifest.id] : [],
      },
    };
    const makeTrial = (planned, mode = "live") => {
      const spec = cases.find((s) => s.id === planned.caseId);
      const trial = {
        ...planned,
        createdAt: time(-1000),
        mode,
        elapsedMs: 500,
        provider: [
          {
            forwarded: true,
            identityValid: true,
            requestedIdentity: { model: profile.model, provider: profile.provider },
            observedIdentity: { generationId: planned.id },
            responseReuseDisabled: true,
            responseCacheHit: false,
            reportedUsd: 0.001,
          },
        ],
        result: {
          configurationId: "c".repeat(64),
          action: "click",
          outcome: spec.expected.outcome,
          summary: { processingComplete: true },
          actions: spec.expected.actions.map(({ step, outcome }) => ({
            actionId: `a${step}`,
            order: step,
            step,
            action: "click",
            outcome,
            ...(outcome === "found"
              ? {
                  target: {
                    candidateId: `c${step}`,
                    ...{
                      xpaths: [`//button[@id='button-${step}']`],
                      state: {
                        rendered: true,
                        inViewport: true,
                        enabled: true,
                        editable: false,
                        accessibilityExposed: true,
                        readonly: false,
                      },
                      interactability: { action: "click" },
                    },
                  },
                }
              : {}),
          })),
        },
        observation: {
          actions: spec.expected.actions.map(() => ({ matches: [{ count: 1, intended: true }] })),
        },
        evidence: {
          systemPrompt: "Synthetic fixture prompt",
          outputSchema: "{}",
          configurationJson: JSON.stringify({
            Model: profile.model,
            Provider: profile.provider,
            Strategy: "candidate-selection",
            effective: {
              scope: "current_view",
              responseCache: false,
              request: {
                model: profile.model,
                stream: false,
                plugins: [{ id: "context-compression", enabled: false }],
                max_tokens: profile.maxTokens,
                reasoning: profile.reasoning,
                provider: {
                  only: [profile.provider],
                  order: [profile.provider],
                  allow_fallbacks: false,
                  require_parameters: true,
                },
              },
            },
          }),
        },
      };
      if (qualificationPolicy && mode === "live" && spec.id === "case-31")
        trial.observation.actions[0].matches[0].intended = false;
      trial.configuration = configurationRecord(trial);
      if (qualificationPolicy) {
        trial.baseline = structuredClone(trial);
        trial.baseline.profileId = "release-baseline";
        trial.baseline.id = hash(`${trial.id}:baseline`).slice(0, 32);
        trial.baseline.provider[0].observedIdentity.generationId = trial.baseline.id;
        trial.baseline.elapsedMs = 3500;
        if (bootstrapBaseline) {
          const config = JSON.parse(trial.baseline.evidence.configurationJson);
          config.OutputTokens = 512;
          trial.baseline.evidence.configurationJson = JSON.stringify(config);
          trial.baseline.configuration = configurationRecord(trial.baseline);
        }
      }
      write(`${path}/trials/${trial.id}.json`, trial);
      return trial;
    };
    const trials = manifest.plan.trials.map((p) => makeTrial(p));
    manifest.contentHash = hash(manifest);
    write(`${path}/manifest.json`, manifest);
    write(`${path}/summary.json`, summarizeQualification(manifest, trials, defaultPolicy));
    return { manifest, trials, path };
  };
  const evaluation = build("evaluation");
  const run = (...args) =>
    spawnSync(process.execPath, ["scripts/release/evidence.mjs", ...args], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        XPATHED_CODE_REVISION: "",
        XPATHED_TREE_HASH: "",
        XPATHED_WORKSPACE: "",
      },
    });
  const seal = (...extra) =>
    run(
      "seal",
      "--evaluation",
      evaluation.path,
      "--profile",
      profile.id,
      "--source-sha",
      sha,
      "--output",
      ".artifacts/candidate.json",
      ...extra,
    );
  const bindArtifact = () => {
    const bundle = ".artifacts/bundle";
    mkdirSync(join(cwd, bundle));
    execFileSync("git", ["archive", "--format=tar", "--output", `${bundle}/source.tar`, sha], {
      cwd,
    });
    writeFileSync(join(cwd, bundle, "images.tar"), "Synthetic image archive; no Docker execution");
    const platform = { os: "linux", architecture: "amd64" };
    const images = ["browser", "resolver"].map((component, index) => ({
      component,
      id: `sha256:${String(index + 1).repeat(64)}`,
      ...platform,
      sourceSha: sha,
    }));
    const files = Object.fromEntries(
      ["source.tar", "images.tar"].map((name) => {
        const bytes = readFileSync(join(cwd, bundle, name));
        return [name, { sha256: hash(bytes), bytes: bytes.length }];
      }),
    );
    write(`${bundle}/manifest.json`, {
      sourceSha: sha,
      platform,
      images,
      files,
    });
    const digest = hash(readFileSync(join(cwd, bundle, "manifest.json")));
    const artifact = {
      version: 1,
      bundleManifestSha256: digest,
      sourceSha: sha,
      profileId: profile.id,
      images,
      platform,
    };
    const observed = images.map((image, index) => ({
      component: image.component,
      imageId: image.id,
      containerId: String(index + 3).repeat(64),
    }));
    for (const run of [evaluation]) {
      run.manifest.qualification.artifact = structuredClone(artifact);
      const baselineArtifact = bootstrapBaseline
        ? {
            ...artifact,
            sourceSha: defaultPolicy.bootstrap.sourceSha,
            images: images.map((image) => ({
              ...image,
              sourceSha: defaultPolicy.bootstrap.sourceSha,
            })),
          }
        : artifact;
      const comparison = qualificationPolicy
        ? { artifact: baselineArtifact, profile, commit: baselineArtifact.sourceSha }
        : undefined;
      if (comparison) run.manifest.comparison = comparison;
      delete run.manifest.contentHash;
      run.manifest.contentHash = hash(run.manifest);
      write(`${run.path}/manifest.json`, run.manifest);
      write(
        `${run.path}/summary.json`,
        summarizeQualification(run.manifest, run.trials, defaultPolicy),
      );
      write(`${run.path}/artifact-before.json`, {
        version: 1,
        artifact,
        observed,
        ...(comparison ? { comparison, baselineObserved: observed } : {}),
      });
      write(`${run.path}/artifact-receipt.json`, {
        version: 1,
        artifact,
        before: observed,
        after: observed,
        ...(comparison ? { comparison, baselineBefore: observed, baselineAfter: observed } : {}),
      });
    }
    return {
      bundle,
      digest,
      artifact,
      observed,
      seal: () => seal("--bundle", bundle, "--bundle-sha256", digest),
    };
  };
  return { cwd, write, run, seal, sha, evaluation, bindArtifact };
}

test("seal, replay and archive bind browser configurations to exact tested artifacts", async (t) => {
  const work = await workspace(t);
  const bound = work.bindArtifact();
  const sealed = bound.seal();
  assert.equal(sealed.status, 0, sealed.stderr);
  const path = join(work.cwd, ".artifacts/candidate.json"),
    bytes = readFileSync(path);
  const candidate = JSON.parse(bytes);
  assert.equal(candidate.version, 3);
  assert.equal(candidate.defaultActivated, undefined);
  assert.equal(candidate.pilot, undefined);
  assert.equal(candidate.evaluation, work.evaluation.path);
  assert.deepEqual(Object.keys(candidate.configurations).sort(), [
    "configured:browser",
    "release-baseline:browser",
  ]);
  assert.equal(work.run("verify", path, "--sha256", hash(bytes)).status, 0);
  const archive = ".artifacts/evidence.json.gz";
  const runArchive = (...args) =>
    spawnSync(process.execPath, ["scripts/release/archive.mjs", ...args], {
      cwd: work.cwd,
      encoding: "utf8",
    });
  const packed = runArchive("pack", path, "--sha256", hash(bytes), archive);
  assert.equal(packed.status, 0, packed.stderr);
  rmSync(join(work.cwd, work.evaluation.path), { recursive: true });
  rmSync(path);
  const restored = runArchive(
    "restore",
    archive,
    "--sha256",
    hash(readFileSync(join(work.cwd, archive))),
  );
  assert.equal(restored.status, 0, restored.stderr);
});

test("sealing rejects missing results, changed policy, lost passes, artifacts and source", async (t) => {
  for (const mutation of [
    "missing",
    "regression",
    "browser-configuration",
    "baseline-browser-configuration",
    "receipt",
    "bundle",
    "policy",
    "source",
    "expired",
    "duplicate",
    "symlink",
    "missing-exclusion",
    "source-count",
  ])
    await t.test(mutation, async (t) => {
      const work = await workspace(t),
        bound = work.bindArtifact();
      const trial = work.evaluation.trials[0];
      if (mutation === "symlink") {
        const path = join(work.cwd, work.evaluation.path, "trials", `${trial.id}.json`);
        const bytes = readFileSync(path);
        rmSync(path);
        const original = join(work.cwd, ".artifacts/original.json");
        writeFileSync(original, bytes);
        symlinkSync(original, path);
      }
      if (mutation === "missing")
        rmSync(join(work.cwd, work.evaluation.path, "trials", `${trial.id}.json`));
      if (mutation === "regression") {
        trial.observation.actions[0].matches[0].intended = false;
        work.write(`${work.evaluation.path}/trials/${trial.id}.json`, trial);
      }
      if (mutation.endsWith("-configuration")) {
        const selected = trial;
        const arm = mutation.startsWith("baseline-") ? selected.baseline : selected;
        arm.evidence.outputSchema = '{"changed":true}';
        const { configurationRecord } = await import(`file://${work.cwd}/evaluation/run.mjs`);
        arm.configuration = configurationRecord(arm);
        work.write(`${work.evaluation.path}/trials/${selected.id}.json`, selected);
        const sealed = bound.seal();
        assert.notEqual(sealed.status, 0);
        assert.match(sealed.stderr, /Configuration changed within an arm/);
      }
      if (mutation === "receipt") work.write(`${work.evaluation.path}/artifact-receipt.json`, {});
      if (mutation === "bundle")
        writeFileSync(join(work.cwd, bound.bundle, "images.tar"), "altered");
      if (mutation === "source") writeFileSync(join(work.cwd, "evaluation/grader.mjs"), "altered");
      if (
        ["policy", "expired", "duplicate", "missing-exclusion", "source-count"].includes(mutation)
      ) {
        const m = work.evaluation.manifest;
        if (mutation === "policy") m.policy.correctnessAcceptance = "allow-losses";
        if (mutation === "expired") m.createdAt = "2020-01-01T00:00:00Z";
        if (mutation === "duplicate") m.plan.trials.push(m.plan.trials[0]);
        if (mutation === "missing-exclusion") m.exclusions = [];
        if (mutation === "source-count") m.sourceCases--;
        delete m.contentHash;
        m.contentHash = hash(m);
        work.write(`${work.evaluation.path}/manifest.json`, m);
      }
      const sealed = bound.seal();
      assert.notEqual(sealed.status, 0);
      if (["missing-exclusion", "source-count"].includes(mutation))
        assert.match(sealed.stderr, /Incomplete release case collection/);
    });
});

test("fresh baseline seals complete candidate evidence and cannot silently omit the baseline later", async (t) => {
  const work = await workspace(t, { qualificationPolicy: null });
  const bound = work.bindArtifact();
  const { retiredReleaseCommit } = await import("./baseline.mjs");
  const { summarizeQualification } = await import(`file://${work.cwd}/evaluation/policy.mjs`);
  const manifest = work.evaluation.manifest;
  manifest.initialBaseline = retiredReleaseCommit;
  delete manifest.contentHash;
  manifest.contentHash = hash(manifest);
  work.write(`${work.evaluation.path}/manifest.json`, manifest);
  work.write(
    `${work.evaluation.path}/summary.json`,
    summarizeQualification(manifest, work.evaluation.trials),
  );
  assert.notEqual(
    bound.seal().status,
    0,
    "Omitting a baseline requires the explicit one-time transition",
  );
  const result = work.seal(
    "--bundle",
    bound.bundle,
    "--bundle-sha256",
    bound.digest,
    "--initial-baseline",
    retiredReleaseCommit,
  );
  assert.equal(result.status, 0, result.stderr);
  const file = join(work.cwd, ".artifacts/candidate.json"),
    bytes = readFileSync(file);
  assert.equal(JSON.parse(bytes).initialBaseline, retiredReleaseCommit);
  const verified = work.run("verify", file, "--sha256", hash(bytes));
  assert.equal(verified.status, 0, verified.stderr);
  const archived = spawnSync(
    process.execPath,
    [
      "scripts/release/archive.mjs",
      "pack",
      file,
      "--sha256",
      hash(bytes),
      ".artifacts/fresh-evidence.json.gz",
    ],
    { cwd: work.cwd, encoding: "utf8" },
  );
  assert.equal(archived.status, 0, archived.stderr);
});
