import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./ci-gate.mjs", import.meta.url));
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
function workspace(t) {
  const cwd = mkdtempSync(join(tmpdir(), "xpathed-ci-gate-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const write = (path, value) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  for (const path of [".github/workflows/check.yml", "package.json", "global.json"])
    write(path, "{}");
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=CI test",
    "-c",
    "user.email=ci@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  const env = {
    ...process.env,
    GITHUB_SHA: git("rev-parse", "HEAD"),
    GITHUB_RUN_ID: "1234",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_STEP_SUMMARY: join(cwd, "step-summary.md"),
  };
  const outputs = {
    dotnet: "[]",
    solution: "false",
    web: "false",
    tooling: "false",
    docker: "false",
    browser: "false",
  };
  const needs = Object.fromEntries(Object.keys(outputs).map((key) => [key, { result: "skipped" }]));
  needs.changes = { result: "success", outputs };
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd,
      env: { ...env, NEEDS_JSON: JSON.stringify(needs) },
      encoding: "utf8",
    });
  return { cwd, write, env, needs, run };
}

test("browser and pipeline logs preserve a failed test command", (t) => {
  const workflow = readFileSync(".github/workflows/check.yml", "utf8");
  const step = workflow.match(
    /- name: Verify Chromium browser and resolution contracts\n([\s\S]*?)(?=\n      - )/,
  )?.[1];
  assert.ok(step);
  assert.match(step, /pnpm test:resolution 2>&1/);
  assert.match(step, /^        shell: bash$/m);
  const command = step.match(/        run: \|\n([\s\S]*)/)?.[1];
  assert.ok(command);
  const cwd = mkdtempSync(join(tmpdir(), "xpathed-ci-browser-log-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-eo",
      "pipefail",
      "-c",
      `pnpm() { echo 'fixture failure'; return 7; };\n${command}`,
    ],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 7, result.stderr);
  assert.match(readFileSync(join(cwd, ".artifacts/ci/browser.log"), "utf8"), /fixture failure/);
});

test("the aggregate accepts receipts from this exact checkout and run and reports the tested identity", (t) => {
  const { cwd, env, run } = workspace(t);
  const recorded = run("record", "changes");
  assert.equal(recorded.status, 0, recorded.stderr);
  const verified = run("verify");
  assert.equal(verified.status, 0, verified.stderr);
  const result = read(join(cwd, ".artifacts/ci/gate.json"));
  assert.equal(result.passed, true);
  assert.equal(result.sha, env.GITHUB_SHA);
  assert.deepEqual(result.jobs, ["changes"]);
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /passed/i);
});

test("selected matrix and ordinary jobs require successful results, while unselected jobs must be skipped", (t) => {
  const { cwd, needs, run } = workspace(t);
  needs.changes.outputs.dotnet = '["Common","Resolver"]';
  needs.changes.outputs.web = needs.changes.outputs.browser = "true";
  needs.dotnet.result = needs.web.result = needs.browser.result = "success";
  for (const job of ["changes", "dotnet-Common", "dotnet-Resolver", "web", "browser"])
    assert.equal(run("record", job).status, 0);
  assert.equal(run("verify").status, 0);
  for (const job of ["dotnet", "web", "browser"]) {
    for (const state of ["failure", "cancelled", "skipped", "neutral", undefined]) {
      needs[job].result = state;
      assert.equal(run("verify").status, 1, `selected ${job} result ${state}`);
      assert.equal(read(join(cwd, ".artifacts/ci/gate.json")).passed, false);
    }
    needs[job].result = "success";
  }
  needs.docker.result = "success";
  assert.equal(run("verify").status, 1, "an unselected job unexpectedly ran");
});

test("invalid selection and incomplete needs cannot produce a passing aggregate", (t) => {
  const { cwd, needs, run } = workspace(t);
  assert.equal(run("record", "changes").status, 0);
  const original = structuredClone(needs);
  for (const change of [
    (value) => {
      value.changes.result = "skipped";
    },
    (value) => {
      delete value.browser;
    },
    (value) => {
      value.extra = { result: "success" };
    },
    (value) => {
      delete value.changes.outputs.browser;
    },
    (value) => {
      value.changes.outputs.browser = "False";
    },
    (value) => {
      value.changes.outputs.dotnet = "null";
    },
    (value) => {
      value.changes.outputs.dotnet = '["Unknown"]';
    },
    (value) => {
      value.changes.outputs.dotnet = '["Resolver","Resolver"]';
    },
  ]) {
    for (const key of Object.keys(needs)) delete needs[key];
    Object.assign(needs, structuredClone(original));
    change(needs);
    assert.equal(run("verify").status, 1);
    assert.equal(read(join(cwd, ".artifacts/ci/gate.json")).passed, false);
  }
});

test("missing, extra, stale and mismatched receipts fail closed", (t) => {
  const { cwd, write, run } = workspace(t);
  assert.equal(run("verify").status, 1, "receipt is absent");
  assert.equal(run("record", "changes").status, 0);
  const receipt = read(join(cwd, ".artifacts/ci/receipts/changes.json"));
  for (const [key, value] of [
    ["sha", "b".repeat(40)],
    ["runId", "5678"],
    ["runAttempt", "2"],
    ["job", "web"],
    ["configuration", {}],
  ]) {
    write(".artifacts/ci/receipts/changes.json", { ...receipt, [key]: value });
    assert.equal(run("verify").status, 1, `receipt ${key}`);
  }
  write(".artifacts/ci/receipts/changes.json", receipt);
  write(".artifacts/ci/receipts/extra.json", receipt);
  assert.equal(run("verify").status, 1, "unexpected receipt");
  rmSync(join(cwd, ".artifacts/ci/receipts/extra.json"));
  write("package.json", '{"changed":true}');
  assert.equal(run("verify").status, 1, "configuration differs from tested job");
  assert.equal(read(join(cwd, ".artifacts/ci/gate.json")).passed, false);
});

test("record and verify reject another checkout SHA and malformed run context with failure evidence", (t) => {
  const { cwd, env, run } = workspace(t);
  const original = { ...env };
  for (const [key, value] of [
    ["GITHUB_SHA", "f".repeat(40)],
    ["GITHUB_SHA", "invalid"],
    ["GITHUB_RUN_ID", ""],
    ["GITHUB_RUN_ATTEMPT", "0"],
  ]) {
    Object.assign(env, original, { [key]: value });
    for (const args of [["record", "changes"], ["verify"]]) {
      assert.equal(run(...args).status, 1);
      assert.equal(read(join(cwd, ".artifacts/ci/gate.json")).passed, false);
    }
  }
});
