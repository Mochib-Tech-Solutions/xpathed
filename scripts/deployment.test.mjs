import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deploymentAddresses,
  fingerprint,
  resolvedDeploymentAddresses,
  runDeployment,
  secretFile,
} from "./deployment.mjs";

test("deployment output hides address fragments on both streams, including failure diagnostics", async () => {
  const environment = {
    DEPLOY_PUBLIC_URL: "https://workspace.example.invalid",
    DEPLOY_HOST: "server.example.invalid",
  };
  const addresses = await resolvedDeploymentAddresses(environment, async () => [
    { address: "192.0.2.8", family: 4 },
    { address: "2001:db8::8", family: 6 },
  ]);
  const output = [];
  const script = `
    process.stdout.write('https://work');
    setTimeout(() => {
      process.stdout.write('space.example.invalid/health ready\\n');
      process.stderr.write('SSH 192.0.2.8 WORKSPACE.EXAMPLE.INVALID failed\\n');
      process.stderr.write('server.example.invalid [2001:db8::8] failed\\n');
      process.exitCode = 1;
    }, 20);
  `;
  await assert.rejects(
    runDeployment(process.execPath, ["-e", script], Buffer.alloc(0), addresses, (line) =>
      output.push(line),
    ),
    /Deployment command failed/,
  );
  const text = output.join("");
  assert.match(text, /\[deployment address\]\/health ready/);
  assert.match(text, /SSH \[deployment address\] \[deployment address\] failed/);
  assert.doesNotMatch(text, /workspace|192\.0\.2|server\.example|2001:db8/i);
  await assert.rejects(
    resolvedDeploymentAddresses(environment, async () => {
      throw new Error(environment.DEPLOY_HOST);
    }),
    (error) => error.message === "Cannot resolve deployment connection address",
  );
  assert.throws(
    () => deploymentAddresses({ DEPLOY_PUBLIC_URL: "private-invalid-value" }),
    (error) =>
      error.message === "Invalid deployment public URL" &&
      !String(error).includes("private-invalid-value"),
  );
  await assert.rejects(
    runDeployment("/missing-deployment-command", [], Buffer.alloc(0), addresses),
    /Deployment command failed/,
  );
});

test("host receiver removes deployment addresses before relaying worker output", () => {
  execFileSync("python3", ["-B", "scripts/deployment-receiver.test.py"], { stdio: "pipe" });
});

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

test("hosted network isolation fails closed during failures and container restarts", () => {
  execFileSync("python3", ["-B", "scripts/deployment-network.test.py"], { stdio: "pipe" });
  execFileSync("python3", ["-B", "scripts/hosted-security.test.py"], { stdio: "pipe" });
});

test("deployment secrets are available only after Check on a main push", () => {
  const workflow = readFileSync(".github/workflows/check.yml", "utf8");
  const deployment = workflow.match(/\n  deploy:\n([\s\S]*?)(?=\n  [\w-]+:|$)/)?.[1] ?? "";
  assert.match(deployment, /needs: check/);
  assert.match(deployment, /!cancelled\(\) && needs\.check\.result == 'success'/);
  assert.match(deployment, /github.event_name == 'push' && github.ref == 'refs\/heads\/main'/);
  assert.match(deployment, /cancel-in-progress: false/);
  assert.match(deployment, /persist-credentials: false/);
});

test("successful main checks cannot hide a skipped or failed deployment", () => {
  const workflow = readFileSync(".github/workflows/check.yml", "utf8");
  const verification =
    workflow.match(/\n  deployment-result:\n([\s\S]*?)(?=\n  [\w-]+:|$)/)?.[1] ?? "";
  assert.match(verification, /needs: \[check, deploy\]/);
  assert.match(verification, /!cancelled\(\) && needs\.check\.result == 'success'/);
  assert.match(verification, /github.event_name == 'push' && github.ref == 'refs\/heads\/main'/);
  assert.match(verification, /DEPLOY_RESULT: \$\{\{ needs\.deploy\.result \}\}/);
  const command = verification.match(/^\s+run: (.+)$/m)?.[1];
  assert.ok(command, "The deployment result must be checked by an executed step");
  for (const result of ["success", "failure", "cancelled", "skipped"]) {
    const outcome = spawnSync("sh", ["-c", command], {
      env: { ...process.env, DEPLOY_RESULT: result },
    });
    assert.equal(outcome.status === 0, result === "success", result);
  }
});
