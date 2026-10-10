import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { projects } from "./ci-changes.mjs";

const directory = ".artifacts/ci";
const flags = ["solution", "web", "tooling", "hosted"];
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
      `CI gate ${result.passed ? "passed" : "failed"} for \`${result.sha}\`. ${result.error ?? "Controlled provider-free checks."}\n`,
    );
}

if (import.meta.main) await main();
