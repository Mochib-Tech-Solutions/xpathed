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
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { gradeTrial } from "../evaluation/grader.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");
async function workspace(
  t,
  { contractVersion = "3", promptVersion = "7", qualificationPolicy } = {},
) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "xpathed-release-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  cpSync("evaluation", join(cwd, "evaluation"), { recursive: true });
  mkdirSync(join(cwd, "scripts"));
  cpSync("scripts/release.mjs", join(cwd, "scripts/release.mjs"));
  cpSync("scripts/release-bundle.mjs", join(cwd, "scripts/release-bundle.mjs"));
  cpSync("scripts/release-archive.mjs", join(cwd, "scripts/release-archive.mjs"));
  writeFileSync(join(cwd, ".gitignore"), ".artifacts/\n");
  const write = (path, value) =>
    writeFileSync(join(cwd, path), JSON.stringify(value, null, 2) + "\n");
  const now = Date.now();
  const time = (offset) => new Date(now + offset).toISOString();
  const cases = Array.from({ length: 34 }, (_, i) => ({
    id: `case-${i}`,
    family: i < 30 ? `held-${Math.floor(i / 3)}` : `family-${i}`,
    split: i < 30 ? "held-out" : [30, 32].includes(i) ? "regression" : "development",
    contractVersion,
    instruction: "Click the labelled buttons",
    fixture: "synthetic",
    setupRevision: "1",
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
  if (qualificationPolicy) suite.sentinels = ["case-31", "case-0"];
  const suitePath = qualificationPolicy
    ? "evaluation/current-view-qualification-cases.json"
    : "evaluation/qualification-cases.json";
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
  const { profiles, baselineEvidence, selectQualificationCases, compatibilityCases } = await import(
    `file://${cwd}/evaluation/qualify.mjs`
  );
  const { policyForSuite, summarizeQualification } = await import(
    `file://${cwd}/evaluation/qualification-policy.mjs`
  );
  const defaultPolicy = policyForSuite(suite);
  const profile = profiles.find((item) => item.id === "deepseek");
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
      baselineEvidence: pilot ? baselineEvidence(pilot) : null,
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
        ...(defaultPolicy.version === "3" && phase === "confirmation"
          ? {
              exposure: {
                repository: "example/private",
                runId: `${phase}-run`,
                sourceSha: code.revision,
                reservedAt: time(-2500),
                families: [
                  ...new Set(
                    selected.cases.filter((c) => c.split === "held-out").map((c) => c.family),
                  ),
                ].sort(),
              },
            }
          : {}),
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
          contractVersion,
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
                    xpaths: [`//button[@id='button-${step}']`],
                    state: { version: "2" },
                    interactability: { version: "2", action: "click" },
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
            Strategy: "candidate-selection-v1",
            PromptVersion: promptVersion,
            effective: {
              ...(contractVersion === "4" ? { scope: "current_view", captureVersion: "5" } : {}),
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
      trial.configuration = configurationRecord(trial);
      write(`${path}/trials/${trial.id}.json`, trial);
      return trial;
    };
    const trials = manifest.plan.trials.map((p) => makeTrial(p));
    const compatibility = compatibilityCases(cases, qualificationPolicy ? selected.cases : []).map(
      (spec, i) => {
        const trial = makeTrial(
          {
            id: hash(`${phase}-compat-${i}`).slice(0, 32),
            caseId: spec.id,
            profileId: profile.id,
            repetition: 1,
            attempt: 1,
          },
          "deterministic",
        );
        return {
          id: trial.id,
          caseId: trial.caseId,
          profileId: trial.profileId,
          grade: gradeTrial(spec, trial),
        };
      },
    );
    write(`${path}/compatibility.json`, compatibility);
    manifest.contentHash = hash(manifest);
    write(`${path}/manifest.json`, manifest);
    write(`${path}/summary.json`, summarizeQualification(manifest, trials, defaultPolicy));
    return { manifest, trials, path };
  };
  const pilot = build("pilot");
  const confirmation = build("confirmation", pilot);
  assert.equal(
    summarizeQualification(confirmation.manifest, confirmation.trials, defaultPolicy).profiles
      .deepseek.qualification.status,
    "qualified",
  );
  const run = (...args) =>
    spawnSync(process.execPath, ["scripts/release.mjs", ...args], {
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
      "--confirmation",
      confirmation.path,
      "--pilot",
      pilot.path,
      "--profile",
      profile.id,
      "--source-sha",
      sha,
      "--output",
      ".artifacts/candidate.json",
      ...(qualificationPolicy ? ["--suite", suitePath] : []),
      ...extra,
    );
  const bindArtifact = () => {
    const bundle = ".artifacts/bundle";
    mkdirSync(join(cwd, bundle));
    execFileSync("git", ["archive", "--format=tar", "--output", `${bundle}/source.tar`, sha], {
      cwd,
    });
    writeFileSync(join(cwd, bundle, "images.tar"), "Synthetic image archive; no Docker execution");
    write(`${bundle}/configuration.json`, {
      version: 1,
      profile,
      resolverEnvironment: {
        OpenRouter__Model: profile.model,
        OpenRouter__Provider: profile.provider,
      },
      secretsRequired: ["OpenRouter__ApiKey"],
      runtimeDefaults: "frozen-in-images",
      defaultActivated: false,
    });
    const platform = { os: "linux", architecture: "amd64" };
    const images = ["browser", "resolver"].map((component, index) => ({
      component,
      id: `sha256:${String(index + 1).repeat(64)}`,
      ...platform,
      sourceSha: sha,
    }));
    const files = Object.fromEntries(
      ["source.tar", "images.tar", "configuration.json"].map((name) => {
        const bytes = readFileSync(join(cwd, bundle, name));
        return [name, { sha256: hash(bytes), bytes: bytes.length }];
      }),
    );
    write(`${bundle}/manifest.json`, {
      version: 1,
      status: "packaged-unqualified",
      defaultActivated: false,
      sourceSha: sha,
      profileId: profile.id,
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
    for (const run of [pilot, confirmation]) {
      run.manifest.qualification.artifact = structuredClone(artifact);
      if (run === confirmation) run.manifest.baselineEvidence = baselineEvidence(pilot);
      delete run.manifest.contentHash;
      run.manifest.contentHash = hash(run.manifest);
      write(`${run.path}/manifest.json`, run.manifest);
      write(`${run.path}/artifact-before.json`, { version: 1, artifact, observed });
      write(`${run.path}/artifact-receipt.json`, {
        version: 1,
        artifact,
        before: observed,
        after: observed,
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
  return { cwd, write, run, seal, sha, pilot, confirmation, bindArtifact };
}

test("artifact-bound sealing verifies both original container attestations and the pinned bundle", async (t) => {
  const work = await workspace(t);
  const bound = work.bindArtifact();
  const result = bound.seal();
  assert.equal(result.status, 0, result.stderr);
  const file = join(work.cwd, ".artifacts/candidate.json");
  const bytes = readFileSync(file);
  const candidate = JSON.parse(bytes);
  assert.equal(candidate.status, "artifact-bound-evidence-verified");
  assert.equal(candidate.defaultActivated, false);
  assert.deepEqual(candidate.artifact, bound.artifact);
  assert.equal(
    Object.keys(candidate.files).filter((path) => path.endsWith("artifact-receipt.json")).length,
    2,
  );
  const verified = work.run("verify", file, "--sha256", hash(bytes));
  assert.equal(verified.status, 0, verified.stderr);
});

test("portable evidence archives verify in a relocated exact-source checkout and reject alteration", async (t) => {
  const work = await workspace(t);
  assert.equal(work.bindArtifact().seal().status, 0);
  const candidate = ".artifacts/candidate.json";
  const digest = hash(readFileSync(join(work.cwd, candidate)));
  const archive = ".artifacts/evidence.json.gz";
  const run = (cwd, ...args) =>
    spawnSync(process.execPath, ["scripts/release-archive.mjs", ...args], {
      cwd,
      encoding: "utf8",
    });
  const packed = run(work.cwd, "pack", candidate, "--sha256", digest, archive);
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = readFileSync(join(work.cwd, archive));
  const destination = realpathSync(mkdtempSync(join(tmpdir(), "xpathed-relocated-")));
  t.after(() => rmSync(destination, { recursive: true, force: true }));
  cpSync(work.cwd, destination, { recursive: true });
  rmSync(join(destination, work.pilot.path), { recursive: true });
  rmSync(join(destination, work.confirmation.path), { recursive: true });
  rmSync(join(destination, candidate));
  assert.match(
    run(destination, "restore", archive, "--sha256", "0".repeat(64)).stderr,
    /digest mismatch/,
  );
  const restored = run(destination, "restore", archive, "--sha256", hash(bytes));
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(hash(readFileSync(join(destination, candidate))), digest);
  assert.notEqual(
    run(destination, "restore", archive, "--sha256", hash(bytes)).status,
    0,
    "existing evidence is never overwritten",
  );
});

test("published candidates require a pinned digest and restore the exact source, images and measured sentinels", async (t) => {
  const work = await workspace(t, {
    contractVersion: "4",
    promptVersion: "8",
    qualificationPolicy: "3",
  });
  const bound = work.bindArtifact();
  assert.equal(bound.seal().status, 0);
  const candidate = ".artifacts/candidate.json";
  const digest = hash(readFileSync(join(work.cwd, candidate)));
  const published = join(work.cwd, ".artifacts/published");
  mkdirSync(published);
  const packed = spawnSync(
    process.execPath,
    [
      "scripts/release-archive.mjs",
      "pack",
      candidate,
      "--sha256",
      digest,
      join(published, "release-evidence.json.gz"),
    ],
    { cwd: work.cwd, encoding: "utf8" },
  );
  assert.equal(packed.status, 0, packed.stderr);
  for (const file of ["manifest.json", "configuration.json", "source.tar"])
    cpSync(join(work.cwd, bound.bundle, file), join(published, file));
  writeFileSync(
    join(published, "images.tar.gz.part-0000"),
    gzipSync(readFileSync(join(work.cwd, bound.bundle, "images.tar"))),
  );
  execFileSync("git", ["remote", "add", "origin", work.cwd], { cwd: work.cwd });
  const bin = join(work.cwd, ".artifacts/bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node\nconst fs=require('node:fs'),p=require('node:path');const dest=process.argv[process.argv.indexOf('--dir')+1];for(const name of fs.readdirSync(process.env.PUBLISHED_FIXTURE))fs.copyFileSync(p.join(process.env.PUBLISHED_FIXTURE,name),p.join(dest,name));\n`,
    { mode: 0o700 },
  );
  const module = pathToFileURL(resolve("scripts/release-fetch.mjs")).href;
  const fetch = (sha, directory) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import {fetchRelease} from ${JSON.stringify(module)}; const result=await fetchRelease('example/private','candidate-1-1',process.argv[1],process.argv[2]); console.log(JSON.stringify(result.release));`,
        sha,
        directory,
      ],
      {
        cwd: work.cwd,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PUBLISHED_FIXTURE: published },
      },
    );
  const wrong = fetch("f".repeat(64), ".artifacts/wrong");
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /pinned candidate/);
  const restored = fetch(digest, ".artifacts/restored");
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /"status":"qualified"/);
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: join(work.cwd, ".artifacts/restored/source"),
      encoding: "utf8",
    }).trim(),
    work.sha,
  );
});

test("artifact-bound sealing fails closed for missing, swapped or downgraded identities and receipts", async (t) => {
  const work = await workspace(t);
  const bound = work.bindArtifact();
  const originals = [work.pilot, work.confirmation].map((run) => structuredClone(run.manifest));
  const saveManifest = (run) => {
    delete run.manifest.contentHash;
    run.manifest.contentHash = hash(run.manifest);
    work.write(`${run.path}/manifest.json`, run.manifest);
  };
  assert.match(
    work.seal().stderr,
    /artifact.*bundle/i,
    "Artifact claims cannot be downgraded to legacy seals",
  );
  for (const run of [work.pilot, work.confirmation]) {
    for (const change of [
      (m) => {
        delete m.qualification.artifact;
      },
      (m) => {
        m.qualification.artifact.images[0].id = `sha256:${"9".repeat(64)}`;
      },
      (m) => {
        m.qualification.artifact.bundleManifestSha256 = "f".repeat(64);
      },
    ]) {
      change(run.manifest);
      saveManifest(run);
      const result = bound.seal();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /artifact/i);
      run.manifest = structuredClone(originals[run === work.pilot ? 0 : 1]);
      saveManifest(run);
    }
    for (const name of ["artifact-before.json", "artifact-receipt.json"]) {
      const path = `${run.path}/${name}`;
      const original = readFileSync(join(work.cwd, path));
      rmSync(join(work.cwd, path));
      assert.equal(bound.seal().status, 1, "Missing attestations cannot qualify images");
      writeFileSync(join(work.cwd, path), original);
    }
    const path = `${run.path}/artifact-receipt.json`;
    const original = JSON.parse(readFileSync(join(work.cwd, path)));
    for (const change of [
      (r) => {
        r.after[0].imageId = `sha256:${"9".repeat(64)}`;
      },
      (r) => {
        r.after[0].containerId = "9".repeat(64);
      },
      (r) => {
        r.before.reverse();
      },
      (r) => {
        r.after.pop();
      },
      (r) => {
        r.artifact.profileId = "qwen";
      },
    ]) {
      const changed = structuredClone(original);
      change(changed);
      work.write(path, changed);
      assert.match(bound.seal().stderr, /attestation/i);
    }
    work.write(path, original);
  }
  const wrongBundle = work.seal("--bundle", bound.bundle, "--bundle-sha256", "0".repeat(64));
  assert.equal(wrongBundle.status, 1);
  assert.match(wrongBundle.stderr, /SHA-256 mismatch/i);
});

test("verify checks the externally pinned digest before reading referenced evidence", (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "xpathed-release-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const candidate = join(directory, "candidate.json");
  writeFileSync(candidate, JSON.stringify({ confirmation: "/missing/private-evidence" }));
  const result = spawnSync(
    process.execPath,
    ["scripts/release.mjs", "verify", candidate, "--sha256", "a".repeat(64)],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Candidate SHA-256 mismatch/);
  assert.doesNotMatch(result.stderr, /private-evidence/);
});

test("seal rejects unsafe, missing, duplicate and unplanned trial files before replay", async (t) => {
  const work = await workspace(t);
  const manifest = work.confirmation.manifest;
  const original = structuredClone(manifest);
  const saveManifest = () => {
    delete manifest.contentHash;
    manifest.contentHash = hash(manifest);
    work.write(`${work.confirmation.path}/manifest.json`, manifest);
  };
  manifest.plan.trials[0].id = "../outside";
  saveManifest();
  assert.match(work.seal().stderr, /Invalid trial identity/);
  Object.assign(manifest, structuredClone(original));
  manifest.plan.trials[1].id = manifest.plan.trials[0].id;
  saveManifest();
  assert.match(work.seal().stderr, /Invalid trial identity/);
  Object.assign(manifest, original);
  saveManifest();
  const first = work.confirmation.trials[0];
  const path = `${work.confirmation.path}/trials/${first.id}.json`;
  rmSync(join(work.cwd, path));
  assert.match(work.seal().stderr, /trial files/);
  work.write(path, first);
  work.write(`${work.confirmation.path}/trials/extra.json`, first);
  assert.match(work.seal().stderr, /trial files/);
  rmSync(join(work.cwd, `${work.confirmation.path}/trials/extra.json`));
  rmSync(join(work.cwd, path));
  symlinkSync(join(work.cwd, `${work.pilot.path}/manifest.json`), join(work.cwd, path));
  assert.match(work.seal().stderr, /regular file|symlink/i);
});

test("seal and verify bind qualified evidence without activating a default or overwriting files", async (t) => {
  const work = await workspace(t);
  const sealed = work.seal();
  assert.equal(sealed.status, 0, sealed.stderr);
  const file = join(work.cwd, ".artifacts/candidate.json");
  const bytes = readFileSync(file);
  const candidate = JSON.parse(bytes);
  assert.equal(candidate.status, "evidence-only-verified");
  assert.equal(candidate.defaultActivated, false);
  assert.equal(candidate.sourceSha, work.sha);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const verified = work.run("verify", file, "--sha256", hash(bytes));
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(work.seal().status, 1);
  assert.deepEqual(readFileSync(file), bytes);
});

test("legacy release policy cannot seal current-view evidence with either current or legacy prompts", async (t) => {
  for (const promptVersion of ["8", "5"]) {
    await t.test(`prompt ${promptVersion}`, async (t) => {
      const work = await workspace(t, { contractVersion: "4", promptVersion });
      const sealed = work.seal();
      assert.equal(sealed.status, 1, sealed.stdout);
      assert.match(sealed.stderr, /current-view qualification policy/i);
    });
  }
});

test("current-view evidence seals only under its frozen policy and actual scope", async (t) => {
  const work = await workspace(t, {
    contractVersion: "4",
    promptVersion: "8",
    qualificationPolicy: "3",
  });
  const sealed = work.seal();
  assert.equal(sealed.status, 0, sealed.stderr);
  const file = join(work.cwd, ".artifacts/candidate.json");
  assert.equal(work.run("verify", file, "--sha256", hash(readFileSync(file))).status, 0);
  rmSync(file);
  const trial = work.confirmation.trials[0];
  const config = JSON.parse(trial.evidence.configurationJson);
  config.effective.scope = "page";
  trial.evidence.configurationJson = JSON.stringify(config);
  const { configurationRecord } = await import(`file://${work.cwd}/evaluation/run.mjs`);
  trial.configuration = configurationRecord(trial);
  work.write(`${work.confirmation.path}/trials/${trial.id}.json`, trial);
  assert.match(work.seal().stderr, /Current-view configuration mismatch/);
});

test("live runner compatibility evidence is regraded and included without becoming qualification attempts", async (t) => {
  const work = await workspace(t);
  const result = work.seal();
  assert.equal(result.status, 0, result.stderr);
  const candidate = JSON.parse(readFileSync(join(work.cwd, ".artifacts/candidate.json")));
  assert.equal(
    Object.keys(candidate.files).filter((p) => p.endsWith("/compatibility.json")).length,
    2,
  );
  const path = `${work.confirmation.path}/compatibility.json`;
  const records = JSON.parse(readFileSync(join(work.cwd, path)));
  records[0].grade.passed = false;
  work.write(path, records);
  const verified = work.run(
    "verify",
    ".artifacts/candidate.json",
    "--sha256",
    hash(readFileSync(join(work.cwd, ".artifacts/candidate.json"))),
  );
  assert.equal(verified.status, 1);
  assert.match(verified.stderr, /compatibility/i);
});

test("seal rejects expired original evidence and self-consistent configuration drift", async (t) => {
  const work = await workspace(t);
  const trial = work.confirmation.trials[0];
  const original = structuredClone(trial);
  const path = `${work.confirmation.path}/trials/${trial.id}.json`;
  const { configurationRecord } = await import(`file://${work.cwd}/evaluation/run.mjs`);
  const save = () => {
    trial.configuration = configurationRecord(trial);
    work.write(path, trial);
  };
  trial.createdAt = new Date(Date.now() - 31 * 86400000).toISOString();
  save();
  assert.match(work.seal().stderr, /expired|timestamp/i);
  for (const change of [
    (t) => {
      t.evidence.systemPrompt = "";
    },
    (t) => {
      t.evidence.outputSchema = "";
    },
    (t) => {
      const c = JSON.parse(t.evidence.configurationJson);
      c.Model = c.effective.request.model = "other/model";
      t.evidence.configurationJson = JSON.stringify(c);
    },
    (t) => {
      const c = JSON.parse(t.evidence.configurationJson);
      c.effective.request.reasoning = { effort: "high" };
      t.evidence.configurationJson = JSON.stringify(c);
    },
    (t) => {
      const c = JSON.parse(t.evidence.configurationJson);
      c.effective.request.max_tokens = 8000;
      t.evidence.configurationJson = JSON.stringify(c);
    },
    (t) => {
      const c = JSON.parse(t.evidence.configurationJson);
      c.effective.request.provider.allow_fallbacks = true;
      t.evidence.configurationJson = JSON.stringify(c);
    },
    (t) => {
      const c = JSON.parse(t.evidence.configurationJson);
      c.effective.responseCache = true;
      t.evidence.configurationJson = JSON.stringify(c);
    },
    (t) => {
      const c = JSON.parse(t.evidence.configurationJson);
      c.effective.request.stream = true;
      t.evidence.configurationJson = JSON.stringify(c);
    },
    (t) => {
      const c = JSON.parse(t.evidence.configurationJson);
      c.effective.request.plugins = [{ id: "context-compression", enabled: true }];
      t.evidence.configurationJson = JSON.stringify(c);
    },
    (t) => {
      t.evidence.systemPrompt = "Different but present prompt";
    },
  ]) {
    Object.assign(trial, structuredClone(original));
    change(trial);
    save();
    assert.match(work.seal().stderr, /configuration|prompt|schema/i);
  }
});

test("seal requires the entire independently graded compatibility inventory", async (t) => {
  const work = await workspace(t);
  const path = `${work.confirmation.path}/compatibility.json`;
  const records = JSON.parse(readFileSync(join(work.cwd, path)));
  const removed = records.pop();
  work.write(path, records);
  rmSync(join(work.cwd, `${work.confirmation.path}/trials/${removed.id}.json`));
  assert.match(work.seal().stderr, /compatibility inventory/i);
});

test("replayed qualification cannot hide an omitted case or a failed attempt behind a saved approval", async (t) => {
  const work = await workspace(t);
  const { summarizeQualification } = await import(
    `file://${work.cwd}/evaluation/qualification-policy.mjs`
  );
  const manifest = work.confirmation.manifest;
  const original = structuredClone(manifest);
  const omitted = manifest.plan.trials.find((p) => p.caseId === "case-32");
  manifest.plan.trials = manifest.plan.trials.filter((p) => p.id !== omitted.id);
  const remaining = work.confirmation.trials.filter((p) => p.id !== omitted.id);
  delete manifest.contentHash;
  manifest.contentHash = hash(manifest);
  work.write(`${work.confirmation.path}/manifest.json`, manifest);
  rmSync(join(work.cwd, `${work.confirmation.path}/trials/${omitted.id}.json`));
  const report = summarizeQualification(manifest, remaining);
  assert.equal(
    report.profiles.deepseek.qualification.status,
    "qualified",
    "policy alone does not certify the entire reviewed source suite",
  );
  work.write(`${work.confirmation.path}/summary.json`, report);
  assert.match(work.seal().stderr, /complete.*plan/i);
  Object.assign(manifest, original);
  work.write(`${work.confirmation.path}/manifest.json`, manifest);
  const missing = work.confirmation.trials.find((p) => p.id === omitted.id);
  work.write(`${work.confirmation.path}/trials/${missing.id}.json`, missing);
  for (const trial of work.confirmation.trials) {
    trial.elapsedMs = 5000;
    work.write(`${work.confirmation.path}/trials/${trial.id}.json`, trial);
  }
  rmSync(join(work.cwd, `${work.confirmation.path}/summary.json`));
  assert.match(work.seal().stderr, /not qualified/i);
});

test("seal binds the actual clean source, browser, policy and original pilot rather than supplied approval labels", async (t) => {
  const work = await workspace(t);
  const m = work.confirmation.manifest;
  const original = structuredClone(m);
  rmSync(join(work.cwd, `${work.confirmation.path}/summary.json`));
  for (const [change, expected] of [
    [
      (value) => {
        value.code.revision = "f".repeat(40);
      },
      /source/i,
    ],
    [
      (value) => {
        value.browserBinarySha256 = null;
      },
      /browser/i,
    ],
    [
      (value) => {
        value.browserBinarySha256 = "a".repeat(64);
      },
      /Chromium/i,
    ],
    [
      (value) => {
        value.policy.deadlineMs = 9999;
      },
      /policy/i,
    ],
    [
      (value) => {
        value.baselineEvidence.manifestHash = "a".repeat(64);
      },
      /baseline/i,
    ],
    [
      (value) => {
        value.createdAt = new Date(Date.now() - 31 * 86400000).toISOString();
      },
      /expired/i,
    ],
    [
      (value) => {
        value.sourceManifestHash = "a".repeat(64);
      },
      /suite/i,
    ],
  ]) {
    Object.assign(m, structuredClone(original));
    change(m);
    delete m.contentHash;
    m.contentHash = hash(m);
    work.write(`${work.confirmation.path}/manifest.json`, m);
    const result = work.seal();
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
  }
  Object.assign(m, original);
  work.write(`${work.confirmation.path}/manifest.json`, m);
  work.write("untracked-source.json", {});
  assert.match(work.seal().stderr, /clean checkout/i);
});

test("verify rejects later evidence edits even when edited trials would still qualify", async (t) => {
  const work = await workspace(t);
  assert.equal(work.seal().status, 0);
  const candidate = ".artifacts/candidate.json";
  const digest = hash(readFileSync(join(work.cwd, candidate)));
  const trial = work.confirmation.trials[0];
  trial.elapsedMs = 600;
  work.write(`${work.confirmation.path}/trials/${trial.id}.json`, trial);
  const { summarizeQualification } = await import(
    `file://${work.cwd}/evaluation/qualification-policy.mjs`
  );
  work.write(
    `${work.confirmation.path}/summary.json`,
    summarizeQualification(work.confirmation.manifest, work.confirmation.trials),
  );
  const result = work.run("verify", candidate, "--sha256", digest);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Candidate evidence changed/);
});
