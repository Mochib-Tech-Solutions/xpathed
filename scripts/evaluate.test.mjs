import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function runWrapper(t, project, service = "web", args = []) {
  const directory = mkdtempSync(join(tmpdir(), "xpathed-evaluation-isolation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, "docker-calls");
  writeFileSync(log, "");
  writeFileSync(
    join(directory, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_DOCKER_LOG"
printf 'suite=%s\\n' "$XPATHED_EVALUATION_SUITE" >> "$TEST_DOCKER_LOG"
case "$1" in
  compose) case "$*" in *"config --quiet") exit 0;; *) exit 77;; esac ;;
  ps) printf '%s\\n' existing-container ;;
  inspect) case "$*" in
    *working_dir*) printf '%s\\n' "$TEST_PROJECT_DIRECTORY" ;;
    *service*) printf '%s\\n' "$TEST_EXISTING_SERVICE" ;;
    *) exit 77 ;;
  esac ;;
  *) exit 77 ;;
esac
`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    "sh",
    ["scripts/evaluate.sh", "--output", join(directory, "artifacts"), ...args],
    {
      encoding: "utf8",
      cwd: resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        TMPDIR: directory,
        XPATHED_EVALUATION_PROJECT: project,
        TEST_DOCKER_LOG: log,
        TEST_PROJECT_DIRECTORY: resolve(import.meta.dirname, ".."),
        TEST_EXISTING_SERVICE: service,
      },
    },
  );
  return { ...result, calls: readFileSync(log, "utf8") };
}

test("evaluation rejects the development project name before invoking Docker", (t) => {
  const result = runWrapper(t, "xpathed");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /xpathed-evaluation/);
  assert.equal(result.calls, "");
});

test("evaluation refuses existing development services before teardown", (t) => {
  const result = runWrapper(t, "xpathed-evaluation-isolation-test");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /non-evaluation service/);
  assert.doesNotMatch(result.calls, /\bdown\b|\bup\b|\brun\b/);
});

test("Qwen service belongs only to the qualification runner", (t) => {
  const rejected = runWrapper(t, "xpathed-evaluation-qwen-rejected", "resolver-qwen");
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /Qualification service belongs to a different runner/);
  assert.doesNotMatch(rejected.calls, /\bdown\b|\bup\b|\brun\b/);
  const accepted = runWrapper(t, "xpathed-evaluation-qwen-accepted", "resolver-qwen", [
    "--qualification",
    "--profile",
    "qwen",
  ]);
  assert.equal(accepted.status, 77);
  assert.match(accepted.calls, /\bdown\b/);
});

test("custom dataset suites cannot enter live mode or read outside the checkout", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xpathed-custom-suite-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "suite.json");
  writeFileSync(path, '{"version":"1","cases":[]}');
  const live = spawnSync("sh", ["scripts/evaluate.sh", "--mode", "live", "--suite", path], {
    encoding: "utf8",
    cwd: resolve(import.meta.dirname, ".."),
  });
  assert.equal(live.status, 2);
  assert.match(live.stderr, /deterministic evaluation only/);
  const outside = spawnSync("sh", ["scripts/evaluate.sh", "--suite", path], {
    encoding: "utf8",
    cwd: resolve(import.meta.dirname, ".."),
  });
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /under this checkout/);
});

test("qualification cannot combine strategy comparison or inject an unreviewed suite", () => {
  for (const args of [
    ["--qualification", "--comparison"],
    ["--qualification", "--suite", "evaluation/cases.json"],
    ["--profile", "gemini"],
  ]) {
    const result = spawnSync("sh", ["scripts/evaluate.sh", ...args], {
      encoding: "utf8",
      cwd: resolve(import.meta.dirname, ".."),
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /qualification|Qualification/);
  }
});

test("qualification accepts the reviewed viewport baseline and forwards its container suite path", (t) => {
  const result = runWrapper(t, "xpathed-evaluation-baseline", "resolver", [
    "--qualification",
    "--suite",
    "evaluation/viewport-baseline-cases.json",
    "--profile",
    "deepseek",
    "--split",
    "regression",
  ]);
  assert.equal(result.status, 77);
  assert.match(result.calls, /suite=\/workspace\/evaluation\/viewport-baseline-cases.json/);
});
