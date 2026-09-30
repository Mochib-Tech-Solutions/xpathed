import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function runWrapper(t, project, service = "web") {
  const directory = mkdtempSync(join(tmpdir(), "xpathed-evaluation-isolation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, "docker-calls");
  writeFileSync(log, "");
  writeFileSync(
    join(directory, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_DOCKER_LOG"
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
    ["scripts/evaluate.sh", "--output", join(directory, "artifacts")],
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
