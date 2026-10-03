import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
  rmSync,
  realpathSync,
  existsSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function workspace(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "xpathed-bundle-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = join(directory, "source");
  mkdirSync(cwd);
  mkdirSync(join(cwd, "scripts"));
  mkdirSync(join(cwd, "evaluation"));
  cpSync("scripts/release/bundle.mjs", join(cwd, "scripts/release/bundle.mjs"));
  cpSync("evaluation/configuration.mjs", join(cwd, "evaluation/configuration.mjs"));
  writeFileSync(join(cwd, ".gitignore"), ".artifacts/\n.env\n");
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Bundle test",
    "-c",
    "user.email=bundle@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Synthetic source",
  );
  const sha = git("rev-parse", "HEAD");
  writeFileSync(join(cwd, ".env"), "OPENROUTER_API_KEY=fixture-secret-not-for-archive\n");
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const log = join(directory, "docker.jsonl");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    BUNDLE_DOCKER_LOG: log,
    BUNDLE_SOURCE_SHA: sha,
    XPATHED_CODE_REVISION: "",
    XPATHED_TREE_HASH: "",
    XPATHED_WORKSPACE: "",
    DOCKER_DEFAULT_PLATFORM: "",
  };
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env node
const fs = require('node:fs'); const args = process.argv.slice(2);
const frozenHost = args[0] === '--host' ? args.splice(0, 2)[1] : null;
if (args[0] !== 'context' && frozenHost !== 'unix:///fixture/docker.sock') process.exit(12);
fs.appendFileSync(process.env.BUNDLE_DOCKER_LOG, JSON.stringify(args) + '\\n');
const ids = { browser: 'sha256:'+'a'.repeat(64), resolver: 'sha256:'+'b'.repeat(64) };
if (args[0] === 'context' && args[1] === 'show') console.log('fixture');
else if (args[0] === 'context' && args[1] === 'inspect') console.log(JSON.stringify([{ Endpoints: { docker: { Host: process.env.BUNDLE_REMOTE ? 'ssh://remote' : 'unix:///fixture/docker.sock' } } }]));
else if (args[0] === 'info') console.log(JSON.stringify({ OSType: 'linux', Architecture: process.env.BUNDLE_PLATFORM || 'x86_64' }));
else if (args[0] === 'build') {
 const bytes = fs.readFileSync(0); if (bytes.includes(Buffer.from('fixture-secret-not-for-archive'))) process.exit(9);
 if(process.env.BUNDLE_FAIL === 'build') process.exit(5);
 const component = args[args.indexOf('--file')+1].includes('browser') ? 'browser' : 'resolver';
 fs.writeFileSync(args[args.indexOf('--iidfile')+1], ids[component]);
} else if (args[0] === 'image' && args[1] === 'inspect') {
 const id = args[args.length-1]; console.log(JSON.stringify([{ Id: process.env.BUNDLE_FAIL === 'inspect' ? ids.browser : id, Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': process.env.BUNDLE_SOURCE_SHA, 'tn.chiboub.xpathed.component': id === ids.browser ? 'browser' : 'resolver' } } }]));
} else if (args[0] === 'image' && args[1] === 'save') {
 if(process.env.BUNDLE_FAIL === 'save') process.exit(6);
 fs.writeFileSync(args[args.indexOf('--output')+1], 'synthetic-image-archive');
} else if (args[0] === 'image' && args[1] === 'load') {
 fs.readFileSync(args[args.indexOf('--input')+1]); console.log('Loaded images');
} else process.exit(7);
`,
    { mode: 0o700 },
  );
  const run = (...args) =>
    spawnSync(process.execPath, ["scripts/release/bundle.mjs", ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
  const output = join(directory, "bundle");
  const create = () => run("create", "--source-sha", sha, "--output", output);
  return { cwd, directory, env, log, sha, run, output, create, git };
}

test("create preserves exact immutable images and verify/restore work after the source changes", (t) => {
  const work = workspace(t);
  const created = work.create();
  assert.equal(created.status, 0, created.stderr);
  const manifestBytes = readFileSync(join(work.output, "manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.sourceSha, work.sha);
  assert.equal(statSync(work.output).mode & 0o777, 0o700);
  for (const file of ["manifest.json", "source.tar", "images.tar"])
    assert.equal(statSync(join(work.output, file)).mode & 0o777, 0o600);
  writeFileSync(join(work.cwd, "changed-source.txt"), "The packaged source stays available");
  work.git("add", "changed-source.txt");
  work.git(
    "-c",
    "user.name=Bundle test",
    "-c",
    "user.email=bundle@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Later source",
  );
  assert.notEqual(work.git("rev-parse", "HEAD"), work.sha);
  const digest = hash(manifestBytes);
  const verified = work.run("verify", work.output, "--sha256", digest);
  assert.equal(verified.status, 0, verified.stderr);
  const restored = work.run("restore", work.output, "--sha256", digest);
  assert.equal(restored.status, 0, restored.stderr);
  const calls = readFileSync(work.log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((args) => args[0] === "build").length, 2);
  assert.ok(
    calls.every(
      (args) => !args.some((arg) => ["run", "compose", "tag", "push", "rm", "rmi"].includes(arg)),
    ),
  );
  const saved = calls.find((args) => args[1] === "save");
  assert.deepEqual(saved.slice(-2), [
    `xpathed/browser:${work.sha}`,
    `xpathed/resolver:${work.sha}`,
  ]);
  assert.ok(
    !readFileSync(join(work.output, "source.tar")).includes(
      Buffer.from("fixture-secret-not-for-archive"),
    ),
  );
  assert.equal(existsSync(join(work.output, "configuration.json")), false);
});

test("a baseline bundle builds the explicitly requested Git commit", (t) => {
  const work = workspace(t);
  writeFileSync(join(work.cwd, "later.txt"), "later commit");
  work.git("add", "later.txt");
  work.git(
    "-c",
    "user.name=Bundle test",
    "-c",
    "user.email=bundle@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Later source",
  );
  const result = work.create();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(work.output, "manifest.json"))).sourceSha, work.sha);
});

test("a caller-pinned digest and exact regular-file inventory gate every restore", (t) => {
  const work = workspace(t);
  assert.equal(work.create().status, 0);
  const manifest = readFileSync(join(work.output, "manifest.json"));
  const digest = hash(manifest);
  const before = readFileSync(work.log, "utf8");
  let result = work.run("restore", work.output, "--sha256", "0".repeat(64));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SHA-256 mismatch/);
  for (const file of ["source.tar", "images.tar"]) {
    const path = join(work.output, file);
    const bytes = readFileSync(path);
    writeFileSync(path, "changed");
    result = work.run("restore", work.output, "--sha256", digest);
    assert.equal(result.status, 1);
    rmSync(path);
    result = work.run("restore", work.output, "--sha256", digest);
    assert.equal(result.status, 1);
    symlinkSync(join(work.output, "manifest.json"), path);
    result = work.run("restore", work.output, "--sha256", digest);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlink/i);
    rmSync(path);
    writeFileSync(path, bytes);
  }
  writeFileSync(join(work.output, "unexpected.json"), "{}");
  result = work.run("restore", work.output, "--sha256", digest);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unexpected or missing/);
  assert.equal(readFileSync(work.log, "utf8"), before);
});

test("failed builds or saves remove only their new bundle and existing output is preserved", (t) => {
  const work = workspace(t);
  for (const failure of ["build", "save"]) {
    work.env.BUNDLE_FAIL = failure;
    const result = work.create();
    assert.equal(result.status, 1);
    assert.equal(existsSync(work.output), false);
  }
  delete work.env.BUNDLE_FAIL;
  assert.equal(work.create().status, 0);
  const original = readFileSync(join(work.output, "manifest.json"));
  assert.equal(work.create().status, 1);
  assert.deepEqual(readFileSync(join(work.output, "manifest.json")), original);
});

test("create rejects dirty or wrong source and unknown profiles without Docker writes", (t) => {
  const work = workspace(t);
  let result = work.run("create", "--source-sha", "0".repeat(40), "--output", work.output);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git rev-parse failed/);
  result = work.run(
    "create",
    "--profile",
    "unknown",
    "--source-sha",
    work.sha,
    "--output",
    work.output,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use create/);
  writeFileSync(join(work.cwd, "dirty.txt"), "Untracked work");
  result = work.create();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /clean checkout/);
  assert.equal(existsSync(work.log), false);
  assert.equal(existsSync(work.output), false);
});

test("restore rejects wrong platform before loading and incorrect restored immutable IDs afterwards", (t) => {
  const work = workspace(t);
  assert.equal(work.create().status, 0);
  const digest = hash(readFileSync(join(work.output, "manifest.json")));
  work.env.BUNDLE_PLATFORM = "aarch64";
  let result = work.run("restore", work.output, "--sha256", digest);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /platform differs/);
  assert.ok(!readFileSync(work.log, "utf8").includes('"load"'));
  delete work.env.BUNDLE_PLATFORM;
  work.env.BUNDLE_FAIL = "inspect";
  result = work.run("restore", work.output, "--sha256", digest);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /identity.*mismatch/i);
});

test("tracked environment secrets are rejected before archiving or Docker access", (t) => {
  const work = workspace(t);
  work.git("add", "--force", ".env");
  work.git(
    "-c",
    "user.name=Bundle test",
    "-c",
    "user.email=bundle@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Invalid tracked environment fixture",
  );
  const sha = work.git("rev-parse", "HEAD");
  const result = work.run("create", "--source-sha", sha, "--output", work.output);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tracked environment/i);
  assert.equal(existsSync(work.log), false);
  assert.equal(existsSync(work.output), false);
});

test("remote Docker contexts cannot receive private source or restored images", (t) => {
  const work = workspace(t);
  work.env.BUNDLE_REMOTE = "true";
  const failed = work.create();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /local.*unix|unix.*local/i);
  assert.equal(existsSync(work.output), false);
  assert.ok(
    readFileSync(work.log, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse)
      .every((args) => args[0] === "context"),
  );
});

test("verify rejects malformed pinned manifests before any Docker operation", (t) => {
  const work = workspace(t);
  assert.equal(work.create().status, 0);
  const path = join(work.output, "manifest.json");
  const original = JSON.parse(readFileSync(path));
  const before = readFileSync(work.log, "utf8");
  for (const change of [
    (m) => {
      m.sourceSha = "invalid";
    },
    (m) => {
      m.files["../outside"] = m.files["images.tar"];
    },
    (m) => {
      m.images[0].id = "latest";
    },
    (m) => {
      m.images[1].component = "browser";
    },
    (m) => {
      m.images[1].id = m.images[0].id;
    },
    (m) => {
      m.platform.os = "windows";
    },
    (m) => {
      m.images[0].architecture = "arm64";
    },

    (m) => {
      m.extra = "not supported";
    },
  ]) {
    const manifest = structuredClone(original);
    change(manifest);
    const bytes = JSON.stringify(manifest);
    writeFileSync(path, bytes);
    const result = work.run("restore", work.output, "--sha256", hash(bytes));
    assert.equal(result.status, 1, JSON.stringify(manifest));
    assert.equal(readFileSync(work.log, "utf8"), before);
  }
});
