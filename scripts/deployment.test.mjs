import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, secretFile } from "./deployment.mjs";

test("deployment key remains parseable when secret storage strips newline or uses CRLF", () => {
  const directory = mkdtempSync(join(tmpdir(), "deployment-key-test-"));
  try {
    const key = join(directory, "key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    const publicKey = execFileSync("ssh-keygen", ["-y", "-f", key], { encoding: "utf8" });
    const value = readFileSync(key, "utf8").trim().replaceAll("\n", "\r\n");
    writeFileSync(key, secretFile(value), { mode: 0o600 });
    assert.equal(execFileSync("ssh-keygen", ["-y", "-f", key], { encoding: "utf8" }), publicKey);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deployment fingerprint skips docs and tests, and detects missed runtime changes and deletions", () => {
  const directory = mkdtempSync(join(tmpdir(), "deployment-test-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "test: inputs",
    );
    return git("rev-parse", "HEAD");
  };
  try {
    git("init");
    mkdirSync(join(directory, "src/Web"), { recursive: true });
    writeFileSync(join(directory, "src/Web/app.ts"), "old");
    const baseline = fingerprint(commit(), directory);
    writeFileSync(join(directory, "README.md"), "docs");
    writeFileSync(join(directory, "test.mjs"), "tests");
    assert.equal(fingerprint(commit(), directory), baseline);
    writeFileSync(join(directory, "src/Web/app.ts"), "new");
    assert.notEqual(fingerprint(commit(), directory), baseline);
    rmSync(join(directory, "src/Web/app.ts"));
    writeFileSync(join(directory, "global.json"), "{}");
    assert.notEqual(fingerprint(commit(), directory), baseline);
    assert.throws(() => fingerprint("main", directory), /Invalid deployment revision/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("host deployment builds first, skips unchanged inputs, and rolls back failures", () => {
  execFileSync("python3", ["-B", "scripts/deployment-host.test.py"], { stdio: "pipe" });
});

test("deployment secrets are available only after Check on a main push", () => {
  const workflow = readFileSync(".github/workflows/check.yml", "utf8");
  const deployment = workflow.slice(workflow.indexOf("\n  deploy:"));
  assert.match(deployment, /needs: check/);
  assert.match(deployment, /!cancelled\(\) && needs\.check\.result == 'success'/);
  assert.match(deployment, /github.event_name == 'push' && github.ref == 'refs\/heads\/main'/);
  assert.match(deployment, /cancel-in-progress: false/);
  assert.match(deployment, /persist-credentials: false/);
});
