import { loadCases } from "../evaluation/cases/load.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { projects } from "./ci-changes.mjs";
import { replay } from "../evaluation/run.mjs";

const directory = ".artifacts/ci";
const flags = ["persistence", "solution", "web", "tooling", "docker", "browser"];
const keys = ["changes", "dotnet", ...flags];
const jobs = ["changes", ...projects.map((project) => `dotnet-${project}`), ...flags];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = async (path, value, options) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", options);
const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function identity() {
  const { GITHUB_SHA: sha, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: runAttempt } = process.env;
  ensure(
    /^[a-f\d]{40}$/.test(sha ?? "") &&
      /^[1-9]\d*$/.test(runId ?? "") &&
      /^[1-9]\d*$/.test(runAttempt ?? ""),
    "Invalid workflow SHA, run ID or run attempt",
  );
  ensure(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() === sha,
    "Checkout HEAD differs from GITHUB_SHA",
  );
  const configuration = {};
  for (const path of [".github/workflows/check.yml", "package.json", "global.json"])
    configuration[path] = hash(await readFile(path));
  return { version: 1, sha, runId, runAttempt, configuration };
}

async function browserEvidence(sha) {
  const path = `${directory}/browser`;
  const manifest = await json(`${path}/manifest.json`);
  const suite = loadCases("evaluation/cases/index.json");
  ensure(
    manifest.mode === "deterministic" && manifest.code?.revision === sha,
    "Browser mode or source SHA mismatch",
  );
  ensure(
    manifest.policy?.qualification === "incomplete",
    "Browser checks cannot claim model qualification",
  );
  ensure(
    manifest.sourceManifestHash === hash(JSON.stringify(suite)) &&
      isDeepStrictEqual(manifest.cases, suite.cases),
    "Browser evidence does not cover the original full suite",
  );
  for (const file of ["package.json", "global.json", "evaluation/cases/index.json"])
    ensure(
      manifest.code.files?.[file] === hash(await readFile(file)),
      `Browser configuration fingerprint mismatch: ${file}`,
    );
  const ids = suite.cases.map((item) => item.id).sort();
  const plan = manifest.plan;
  ensure(
    plan?.repetitions === 1 &&
      plan.concurrency === 1 &&
      plan.retries === 0 &&
      isDeepStrictEqual([...plan.caseOrder].sort(), ids) &&
      plan.trials?.length === ids.length,
    "Browser plan must run every case once without retries",
  );
  ensure(
    isDeepStrictEqual(plan.trials.map((trial) => trial.caseId).sort(), ids),
    "Browser plan is missing or duplicating cases",
  );
  const trialIds = new Set();
  for (const planned of plan.trials) {
    ensure(
      /^[a-f\d]{32}$/.test(planned.id) &&
        !trialIds.has(planned.id) &&
        planned.repetition === 1 &&
        planned.attempt === 1,
      "Invalid browser first-attempt identity",
    );
    trialIds.add(planned.id);
    const trial = await json(`${path}/trials/${planned.id}.json`);
    for (const key of ["id", "caseId", "repetition", "attempt"])
      ensure(trial[key] === planned[key], `Browser trial identity mismatch: ${planned.id}`);
  }
  ensure(
    isDeepStrictEqual(
      (await readdir(`${path}/trials`)).sort(),
      [...trialIds].map((id) => `${id}.json`).sort(),
    ),
    "Missing or extra browser trials",
  );
  const configurations = Object.entries(manifest.configurations ?? {});
  ensure(
    configurations.length > 0 &&
      configurations.every(
        ([id, value]) =>
          value.configurationId === id &&
          value.effective?.endpoint === "http://evaluation-fixture:8090/api/v1/" &&
          value.effective.responseCache === false,
      ),
    "Browser configuration must use the deterministic fixture without response reuse",
  );
  const summary = await replay(path);
  ensure(
    isDeepStrictEqual(await json(`${path}/summary.json`), summary),
    "Saved browser summary differs from replay",
  );
  ensure(
    summary.passed === true &&
      summary.completedTrials === ids.length &&
      summary.missingTrials === 0 &&
      summary.diagnosticReruns.trials === 0 &&
      summary.qualification === "incomplete" &&
      summary.modelQualityMeasured === false,
    "Browser deterministic checks failed or are incomplete",
  );
  return {
    trials: ids.length,
    suiteHash: manifest.sourceManifestHash,
    manifestHash: manifest.contentHash,
    summaryHash: hash(JSON.stringify(summary)),
    configurationHash: hash(JSON.stringify(manifest.configurations)),
  };
}

async function main() {
  const [command, job, ...extra] = process.argv.slice(2);
  const result = { passed: false, sha: process.env.GITHUB_SHA ?? null };
  await mkdir(`${directory}/receipts`, { recursive: true });
  try {
    Object.assign(result, await identity());
    ensure(
      extra.length === 0 &&
        (command === "record" ? jobs.includes(job) : command === "verify" && !job),
      "Use record JOB_KEY or verify",
    );
    if (command === "record") {
      await save(
        `${directory}/receipts/${job}.json`,
        {
          ...(await identity()),
          job,
          ...(job === "browser" ? { browser: await browserEvidence(result.sha) } : {}),
        },
        { flag: "wx" },
      );
      return;
    }
    const needs = JSON.parse(process.env.NEEDS_JSON);
    ensure(
      isDeepStrictEqual(Object.keys(needs).sort(), [...keys].sort()),
      "Missing or extra workflow dependencies",
    );
    ensure(needs.changes?.result === "success", "Change selection did not succeed");
    const outputs = needs.changes.outputs;
    const selected = JSON.parse(outputs.dotnet);
    ensure(
      Array.isArray(selected) &&
        selected.every((project) => projects.includes(project)) &&
        new Set(selected).size === selected.length,
      "Invalid .NET project selection",
    );
    for (const key of flags)
      ensure(["true", "false"].includes(outputs[key]), `Invalid selection: ${key}`);
    for (const key of keys) {
      const required =
        key === "changes" || (key === "dotnet" ? selected.length > 0 : outputs[key] === "true");
      ensure(
        needs[key]?.result === (required ? "success" : "skipped"),
        `Unexpected job result: ${key} (${needs[key]?.result ?? "missing"})`,
      );
    }
    result.jobs = [
      "changes",
      ...selected.map((project) => `dotnet-${project}`),
      ...flags.filter((key) => outputs[key] === "true"),
    ];
    const files = await readdir(`${directory}/receipts`);
    ensure(
      isDeepStrictEqual(files.sort(), result.jobs.map((key) => `${key}.json`).sort()),
      "Missing or extra job receipts",
    );
    const current = await identity();
    for (const key of result.jobs)
      ensure(
        isDeepStrictEqual(await json(`${directory}/receipts/${key}.json`), {
          ...current,
          job: key,
          ...(key === "browser" ? { browser: await browserEvidence(result.sha) } : {}),
        }),
        `Receipt identity mismatch: ${key}`,
      );
    result.passed = true;
  } catch (error) {
    result.error = error.message;
    process.exitCode = 1;
    console.error(error.message);
  }
  await save(`${directory}/gate.json`, result);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `CI gate ${result.passed ? "passed" : "failed"} for \`${result.sha}\`. ${result.error ?? "Deterministic engineering checks; no model qualification."}\n`,
    );
}

if (import.meta.main) await main();
