import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEvaluationKey } from "../evaluation/environment.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
export const categories = [
  { name: "xpath", label: "XPath construction and verification", args: ["--xpath"] },
  { name: "resolver", label: "Live-browser Resolver", args: ["--mode", "live"] },
];

async function execute(args) {
  return new Promise((done, reject) => {
    const child = spawn("sh", ["scripts/evaluate.sh", ...args], { cwd: root, stdio: "inherit" });
    const onInt = () => child.kill("SIGINT");
    const onTerm = () => child.kill("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    const cleanup = () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      cleanup();
      done(signal ? 130 : (code ?? 1));
    });
  });
}

export async function runEvaluationSet(output, run = execute) {
  await mkdir(output, { recursive: false, mode: 0o700 });
  const results = [];
  for (const category of categories) {
    console.log(
      `\n${category.label}; inference mode: ${category.name === "xpath" ? "controlled provider-free" : "live provider inference"}`,
    );
    const directory = join(output, category.name);
    const code = await run([...category.args, "--output", directory]);
    const summary = await readFile(join(directory, "summary.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    results.push({
      category: category.name,
      exitCode: code,
      output: directory,
      passed: code === 0 && summary?.passed === true,
      planned: summary?.plannedTrials ?? null,
      completed: summary?.completedTrials ?? null,
      checksPassed: summary?.firstAttempt?.passed ?? null,
      cost: summary?.firstAttempt?.cost ?? null,
    });
    await writeFile(
      join(output, "summary.json"),
      JSON.stringify(
        {
          passed: results.length === categories.length && results.every((item) => item.passed),
          categories: results,
          pending: categories.slice(results.length).map((item) => item.name),
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    if (code === 130 || code === 143 || summary?.stopFurtherInference) break;
  }
  console.log(`\nEvaluation results: ${join(output, "summary.json")}`);
  for (const item of results)
    console.log(
      `${item.passed ? "PASS" : "FAIL"} ${categories.find((category) => category.name === item.category).label}: ${item.checksPassed ?? "unavailable"}/${item.planned ?? "unavailable"}`,
    );
  return results.length === categories.length && results.every((item) => item.passed) ? 0 : 1;
}

export async function main(args = process.argv.slice(2)) {
  args = args.filter((arg) => arg !== "--");
  if (args.length === 1 && args[0] === "--help") {
    console.log(`pnpm evaluate [--output DIRECTORY]
Runs Live-browser Resolver with live provider inference.
Runs XPath construction and verification with controlled provider-free selections.
Requires the native browser setup and OPENROUTER_EVAL_API_KEY. Makes paid model calls.
Separate commands: evaluate:xpath, evaluate:resolver:live.
Live-browser Resolver with controlled provider-free responses: evaluate:resolver. Replay: evaluate:replay RUN_DIRECTORY.`);
    return 0;
  }
  if (
    args.length &&
    (args.length !== 2 || args[0] !== "--output" || !args[1] || args[1].startsWith("--"))
  )
    throw new Error(
      "Use evaluate [--output DIRECTORY]; use separate category commands to filter cases",
    );
  process.chdir(root);
  if (!(await readEvaluationKey()))
    throw new Error("Set OPENROUTER_EVAL_API_KEY for live provider inference");
  const output = resolve(args[1] ?? join(".artifacts/evaluation", randomUUID()));
  await mkdir(resolve(output, ".."), { recursive: true });
  return runEvaluationSet(output);
}

if (import.meta.main)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 2;
    });
