import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function runWrapper(
  t,
  project,
  service = "web",
  args = [],
  { envText = "", environment = {} } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "xpathed-evaluation-isolation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, "docker-calls");
  writeFileSync(log, "");
  const envFile = join(directory, ".env");
  writeFileSync(envFile, envText);
  writeFileSync(
    join(directory, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_DOCKER_LOG"
printf 'suite=%s\\n' "$XPATHED_EVALUATION_SUITE" >> "$TEST_DOCKER_LOG"
if [ -z "$OPENROUTER_EVAL_API_KEY" ]; then key_state=empty
elif [ "$OPENROUTER_EVAL_API_KEY" = fixture-eval ]; then key_state=selected
else key_state=unexpected; fi
printf 'evaluation-key=%s\\n' "$key_state" >> "$TEST_DOCKER_LOG"
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
        OPENROUTER_API_KEY: "",
        OPENROUTER_EVAL_API_KEY: "",
        XPATHED_ENV_FILE: envFile,
        ...environment,
      },
    },
  );
  return { ...result, calls: readFileSync(log, "utf8") };
}

test("live evaluation wrappers pass the dedicated file key and reject an app-only file before Docker", async (t) => {
  for (const args of [[], ["--qualification"]]) {
    await t.test(args[0] ?? "direct", (t) => {
      const selected = runWrapper(t, "xpathed-evaluation-key", "web", ["--mode", "live", ...args], {
        envText: "OPENROUTER_API_KEY=fixture-app\nOPENROUTER_EVAL_API_KEY=fixture-eval\n",
      });
      assert.equal(selected.status, 2);
      assert.match(selected.stderr, /non-evaluation service/);
      assert.match(selected.calls, /evaluation-key=selected/);
      const missing = runWrapper(t, "xpathed-evaluation-key", "web", ["--mode", "live", ...args], {
        envText: "OPENROUTER_API_KEY=fixture-app\n",
      });
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /Set OPENROUTER_EVAL_API_KEY/);
      assert.equal(missing.calls, "");
      assert.doesNotMatch(missing.stdout + missing.stderr, /fixture-app/);
    });
  }
});

test("deterministic evaluation removes the dedicated key before invoking Docker", (t) => {
  const result = runWrapper(t, "xpathed-evaluation-key", "web", ["--qualification"], {
    envText: "OPENROUTER_EVAL_API_KEY=fixture-eval\n",
    environment: { OPENROUTER_EVAL_API_KEY: "fixture-eval" },
  });
  assert.equal(result.status, 2);
  assert.match(result.calls, /evaluation-key=empty/);
  assert.doesNotMatch(result.calls, /evaluation-key=selected/);
});

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
    ["--qualification", "--suite", "evaluation/cases/unavailable.json"],
    ["--profile", "gemini"],
  ]) {
    const result = spawnSync("sh", ["scripts/evaluate.sh", ...args], {
      encoding: "utf8",
      cwd: resolve(import.meta.dirname, ".."),
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /qualification|Qualification|Unknown evaluation option/);
  }
});

test("release comparison accepts the unified collection and forwards its container path", (t) => {
  const result = runWrapper(t, "xpathed-evaluation-baseline", "resolver", [
    "--qualification",
    "--suite",
    "evaluation/cases/index.json",
  ]);
  assert.equal(result.status, 77);
  assert.match(result.calls, /suite=\/workspace\/evaluation\/cases\/index.json/);
});

test("browser concurrency is bounded and cannot leak into live or comparison runners", (t) => {
  for (const args of [
    ["--concurrency", "0"],
    ["--concurrency", "5"],
    ["--concurrency", "2", "--mode", "live"],
    ["--concurrency", "2", "--qualification"],
  ]) {
    const result = runWrapper(t, "xpathed-evaluation-workers", "resolver", args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /concurrency/i);
    assert.equal(result.calls, "");
  }
  const valid = runWrapper(t, "xpathed-evaluation-workers", "resolver", ["--concurrency", "4"]);
  assert.equal(valid.status, 77);
  assert.match(valid.calls, /down/);
});
