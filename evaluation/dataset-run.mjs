import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildPlan,
  fingerprints,
  replay,
  toArtifact,
  validateCases,
  retainConfigurations,
} from "./run.mjs";
import { gradeTrial, summarize } from "./grader.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });

export function makeCase(item) {
  return {
    id: item.id,
    dataset: item.dataset,
    split: item.split,
    family: `${item.dataset}/${item.family}`,
    track: "offline-selection",
    category: "external-target",
    instruction: item.instruction,
    setupRevision: item.transformationVersion ?? "external-targets-v1",
    review: item.provenance.adaptation ?? {
      status: "source-annotation",
      actionLabel: "unavailable",
    },
    provenance: item.provenance,
    inputKey: item.inputKey,
    expected: {
      outcome: "found",
      actions: [
        {
          step: 1,
          ...(item.action ? { action: item.action } : {}),
          outcome: "found",
          target: { candidateId: item.oracle.candidateId },
        },
      ],
    },
  };
}

// A deliberately simple diagnostic baseline. It sees no oracle and measures no model quality.
export function lexicalSelection(input) {
  const words = (text) => new Set((text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const query = words(input.instruction);
  const ignored = new Set("click on the a an button link please all in of to this that".split(" "));
  const ranked = input.candidates
    .map((candidate) => {
      const label = words(candidate.label || candidate.text || candidate.placeholder);
      const terms = [...label].filter((word) => !ignored.has(word));
      const overlap = terms.filter((word) => query.has(word)).length;
      return { id: candidate.id, score: terms.length ? overlap / terms.length : 0 };
    })
    .sort((a, b) => b.score - a.score);
  const tied = ranked.filter((item) => item.score > 0 && item.score === ranked[0]?.score);
  const action = /\bhover\b/i.test(input.instruction)
    ? "hover"
    : /\bclick\b/i.test(input.instruction)
      ? "click"
      : "inspect";
  const selected = tied.length === 1 ? tied[0].id : null;
  return {
    action: selected ? action : "unsupported",
    actions: [
      {
        step: 1,
        instruction: input.instruction.slice(0, 300),
        action: selected ? action : "unsupported",
        outcome: selected ? "found" : "unsupported",
        candidateId: selected,
        limitation: selected ? "none" : "ambiguous",
      },
    ],
    diagnostics: { strategy: "lexical-diagnostic", modelCalls: 0 },
  };
}

export function reserveCharge(ledger, maximumUsd, id) {
  if (!Number.isFinite(maximumUsd) || maximumUsd <= 0) throw new Error("Invalid maximum charge");
  if (
    !Number.isFinite(ledger.ceilingUsd) ||
    ledger.ceilingUsd <= 0 ||
    ledger.ceilingUsd > 5 ||
    !Array.isArray(ledger.entries)
  )
    throw new Error("Invalid budget ledger");
  const spent = ledger.entries.reduce((sum, entry) => {
    const charge = entry.reportedUsd ?? entry.reservedUsd;
    if (!Number.isFinite(charge) || charge < 0) throw new Error("Invalid retained charge");
    return sum + charge;
  }, 0);
  if (spent + maximumUsd > ledger.ceilingUsd)
    throw new Error("Total experiment budget would be exceeded");
  if (ledger.entries.some((entry) => entry.id === id))
    throw new Error("Repeated attempt reservation");
  ledger.entries.push({ id, reservedUsd: maximumUsd, reportedUsd: null });
  return maximumUsd;
}

function options(args) {
  const result = { mode: "deterministic", limit: 30, seed: 1, budgetUsd: 5, split: "train" };
  const keys = {
    "--import": "import",
    "--output": "output",
    "--mode": "mode",
    "--limit": "limit",
    "--seed": "seed",
    "--replay": "replay",
    "--budget-usd": "budgetUsd",
    "--split": "split",
    "--reviewed-inputs": "reviewedInputs",
  };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = keys[args[i]];
    if (!key || seen.has(key) || !args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error("Unknown, repeated or missing dataset option");
    seen.add(key);
    result[key] = args[i + 1];
  }
  if (result.replay) {
    if (seen.size !== 1) throw new Error("Replay cannot be combined with other options");
    return result;
  }
  if (!result.import || !result.output || !["deterministic", "live"].includes(result.mode))
    throw new Error("Specify --import, --output and a supported mode");
  for (const [key, min, max] of [
    ["limit", 1, 100000],
    ["seed", 0, 4294967295],
  ]) {
    result[key] = Number(result[key]);
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max)
      throw new Error(`Invalid ${key}`);
  }
  if (!["train", "dev", "test", "test_task", "test_website", "test_domain"].includes(result.split))
    throw new Error("Invalid original dataset split");
  if (result.mode === "live" && !result.reviewedInputs)
    throw new Error(
      "Live dataset calls require --reviewed-inputs with exact input hashes and privacy review",
    );
  result.budgetUsd = Number(result.budgetUsd);
  if (!(result.budgetUsd > 0 && result.budgetUsd <= 5))
    throw new Error("Initial experiment ceiling must be at most $5 total");
  return result;
}

async function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const line = (await readFile(process.env.XPATHED_ENV_FILE ?? ".env", "utf8"))
      .split(/\r?\n/)
      .find((value) => /^OPENROUTER_API_KEY=/.test(value));
    return line
      ?.slice("OPENROUTER_API_KEY=".length)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function cli(path, env, prepareOnly = false) {
  const command = spawnSync(
    "dotnet",
    [
      "src/Resolver/bin/Release/net10.0/Resolver.dll",
      "--evaluate-offline",
      path,
      ...(prepareOnly ? ["--prepare-only"] : []),
    ],
    { env, encoding: "utf8", timeout: 65000, maxBuffer: 2_000_000 },
  );
  if (command.error || !command.stdout?.trim())
    throw new Error(
      "Offline resolver process did not return evidence; its reserved cost remains charged",
    );
  try {
    return JSON.parse(command.stdout);
  } catch {
    throw new Error(
      "Offline resolver returned malformed evidence; its reserved cost remains charged",
    );
  }
}

function normalize(result, attemptId) {
  if (result.outcome === "error")
    return {
      contractVersion: "offline-1",
      outcome: "error",
      action: null,
      actions: [],
      summary: null,
      diagnostics: result.diagnostics,
      configurationId: result.configurationId,
      attemptId,
    };
  if (!Array.isArray(result.actions) || !result.actions.length)
    throw new Error("Offline selection has no target items");
  const outcomes = new Set(result.actions.map((item) => item.outcome));
  return {
    contractVersion: "offline-1",
    outcome: outcomes.size === 1 ? result.actions[0].outcome : "partial",
    action: result.action,
    attemptId,
    configurationId: result.configurationId,
    actions: result.actions.map((item, index) => ({
      actionId: `a${index + 1}`,
      order: index + 1,
      step: item.step,
      action: item.action,
      outcome: item.outcome,
      diagnosticsReference: attemptId,
      target: item.candidateId == null ? null : { candidateId: item.candidateId },
    })),
    diagnostics: result.diagnostics ?? {},
  };
}

export async function main(args = process.argv.slice(2)) {
  const opt = options(args);
  if (opt.replay) {
    const summary = await replay(resolve(opt.replay));
    console.log(JSON.stringify(summary, null, 2));
    return summary.passed ? 0 : 1;
  }
  const source = resolve(opt.import),
    output = resolve(opt.output);
  const caseText = await readFile(join(source, "cases.json"), "utf8");
  const inventoryText = await readFile(join(source, "inventory.json"), "utf8");
  const importManifest = await json(join(source, "manifest.json"));
  if (
    hash(caseText) !== importManifest.casesSha256 ||
    hash(inventoryText) !== importManifest.inventorySha256
  )
    throw new Error("Imported cases or inventory integrity mismatch");
  const imported = JSON.parse(caseText);
  const inventory = JSON.parse(inventoryText);
  const eligible = imported
    .filter((item) => item.status === "offline-eligible" && item.split === opt.split)
    .map(makeCase);
  if (!eligible.length)
    throw new Error(
      "No independently labelled eligible cases; instruction adaptation may be required",
    );
  validateCases({ version: "1", cases: eligible });
  const planOptions = { seed: opt.seed, repetitions: 1, timeoutMs: 60000 };
  const reviews = opt.reviewedInputs ? await json(resolve(opt.reviewedInputs)) : null;
  if (
    reviews &&
    (reviews.version !== 1 ||
      !Array.isArray(reviews.entries) ||
      reviews.entries.some(
        (item) =>
          !item.caseId ||
          !/^[a-f0-9]{64}$/.test(item.inputHash) ||
          !item.reviewer ||
          !Number.isFinite(Date.parse(item.reviewedAt)) ||
          item.providerSubmission !== true,
      ) ||
      new Set(reviews.entries.map((item) => item.caseId)).size !== reviews.entries.length)
  )
    throw new Error("Invalid provider submission review");
  const selectable = reviews
    ? eligible.filter((item) => reviews.entries.some((review) => review.caseId === item.id))
    : eligible;
  if (!selectable.length) throw new Error("No reviewed cases in the selected split");
  const ids = buildPlan(selectable, planOptions).caseOrder.slice(0, opt.limit);
  const cases = ids.map((id) => eligible.find((item) => item.id === id));
  const plan = buildPlan(cases, planOptions);
  plan.trials = plan.trials.map((item) => ({ ...item, id: randomUUID().replaceAll("-", "") }));
  const manifest = {
    version: "1",
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    mode: opt.mode,
    track: "offline-selection",
    measurement:
      opt.mode === "live"
        ? "offline model target selection"
        : "lexical diagnostic baseline, not model quality",
    unavailable: ["historical geometry", "browser XPath identity", "interaction readiness"],
    cases,
    plan,
    code: await fingerprints(),
    configurations: {},
    sourceManifestHash: hash(JSON.stringify(importManifest)),
    inventory,
    selection: {
      split: opt.split,
      eligible: eligible.length,
      sampled: cases.length,
      reviewed: reviews ? selectable.length : null,
      method: "seeded-without-replacement",
      seed: opt.seed,
    },
    policy: {
      qualification: "incomplete",
      historicalState: "unavailable",
      xpathVerification: "unavailable",
      retentionDays: 90,
      evidenceDays: 30,
    },
  };
  await mkdir(output, { mode: 0o700 });
  await mkdir(join(output, "trials"));
  await mkdir(join(output, "imports"));
  let ledger, lock, ledgerPath, env;
  const persistLedger = async () => {
    await writeFile(`${ledgerPath}.pending`, JSON.stringify(ledger, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(`${ledgerPath}.pending`, ledgerPath);
  };
  try {
    if (opt.mode === "live") {
      const key = await apiKey();
      if (!key) throw new Error("Set OPENROUTER_API_KEY for an explicitly requested live pilot");
      ledgerPath = resolve(".artifacts/datasets/experiment-budget.json");
      await mkdir(resolve(".artifacts/datasets"), { recursive: true });
      await mkdir(`${ledgerPath}.lock`);
      lock = `${ledgerPath}.lock`;
      try {
        ledger = await json(ledgerPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        ledger = { version: 1, ceilingUsd: opt.budgetUsd, entries: [] };
      }
      ledger.ceilingUsd = Math.min(ledger.ceilingUsd, opt.budgetUsd);
      if (ledger.entries.some((entry) => entry.reportedUsd == null))
        throw new Error(
          "Unreconciled prior attempt: inspect its retained reservation before further paid calls",
        );
      const response = await fetch(
        "https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints",
        { signal: AbortSignal.timeout(10000) },
      );
      if (!response.ok) throw new Error("Current route pricing is unavailable");
      const endpoint = (await response.json()).data.endpoints.find((item) => item.tag === "wafer");
      const rate = endpoint?.pricing;
      if (
        !rate ||
        rate.overrides ||
        !Number.isFinite(Number(rate.prompt)) ||
        Number(rate.prompt) <= 0 ||
        !Number.isFinite(Number(rate.completion)) ||
        Number(rate.completion) <= 0 ||
        !Number.isFinite(Number(rate.request ?? 0)) ||
        Number(rate.request ?? 0) < 0
      )
        throw new Error("Unbounded or missing route prices");
      manifest.pricing = { ...rate, fetchedAt: new Date().toISOString() };
      env = {
        ...process.env,
        OpenRouter__ApiKey: key,
        OpenRouter__BaseUrl: "https://openrouter.ai/api/v1/",
        OpenRouter__Model: "deepseek/deepseek-v4.1-flash",
        OpenRouter__Provider: "wafer",
        OpenRouter__TimeoutSeconds: "30",
        XPATHED_EVALUATION_PRICE_LIMITS: JSON.stringify({
          prompt: Number(rate.prompt) * 1_000_000,
          completion: Number(rate.completion) * 1_000_000,
          request: Number(rate.request ?? 0),
        }),
      };
      manifest.policy.experimentCeilingUsd = ledger.ceilingUsd;
      await persistLedger();
    }
    manifest.contentHash = hash(JSON.stringify(manifest));
    await save(join(output, "manifest.json"), manifest);
    const trials = [];
    for (const planned of plan.trials) {
      const spec = cases.find((item) => item.id === planned.caseId);
      const trial = {
        ...planned,
        createdAt: new Date().toISOString(),
        result: null,
        evidence: null,
      };
      const started = performance.now();
      let stop = false;
      let inputPath;
      try {
        if (!/^[a-f0-9]{64}$/.test(spec.inputKey))
          throw new Error("Invalid imported input identity");
        const inputText = await readFile(join(source, "inputs", `${spec.inputKey}.json`), "utf8");
        if (hash(inputText) !== spec.inputKey) throw new Error("Imported input integrity mismatch");
        const input = { instruction: spec.instruction, ...JSON.parse(inputText) };
        if (reviews) {
          const review = reviews.entries.find((item) => item.caseId === spec.id);
          if (hash(JSON.stringify(input)) !== review.inputHash)
            throw new Error("Prepared input differs from its provider submission review");
          trial.submissionReview = review;
        }
        const inputIds = input.candidates.map((item) => item.id);
        trial.observation = {
          modelInputCoverage: {
            expected: 1,
            found: Number(inputIds.includes(spec.expected.actions[0].target.candidateId)),
          },
        };
        let result;
        if (opt.mode === "live") {
          inputPath = join(output, "trials", `${trial.id}.input.json`);
          await save(inputPath, input);
          const prepared = cli(inputPath, env, true);
          if (prepared.outcome === "error")
            throw new Error("Offline resolver rejected the prepared input");
          trial.evidence = {
            availability: "available",
            modelInput: prepared.modelInput,
            systemPrompt: prepared.prompt,
            outputSchema: JSON.stringify(prepared.schema),
            configurationJson: JSON.stringify({
              Model: prepared.effective.request.model,
              Provider: prepared.effective.request.provider.only[0],
              Strategy: prepared.effective.strategy,
              PromptVersion: prepared.promptVersion,
              effective: prepared.effective,
            }),
          };
          trial.result = { configurationId: prepared.configurationId };
          await retainConfigurations(output, manifest, trial);
          // UTF-8 bytes plus conservative framing allowance bound byte-level tokenization; output includes reasoning.
          const maximumInput = Buffer.byteLength(JSON.stringify(prepared)) + 16384;
          const maximum =
            maximumInput * Number(manifest.pricing.prompt) +
            4096 * Number(manifest.pricing.completion) +
            Number(manifest.pricing.request ?? 0);
          reserveCharge(ledger, maximum * 1.2, trial.id);
          await persistLedger();
          result = cli(inputPath, env);
          const charge = result.diagnostics?.usage?.cost;
          const reservation = ledger.entries.find((entry) => entry.id === trial.id);
          if (typeof charge === "number" && Number.isFinite(charge) && charge >= 0)
            reservation.reportedUsd = charge;
          stop = reservation.reportedUsd == null || charge > reservation.reservedUsd;
          await persistLedger();
        } else result = lexicalSelection(input);
        trial.result = normalize(result, trial.id);
        trial.elapsedMs = performance.now() - started;
      } catch (error) {
        trial.error = { code: "dataset_trial_error", message: error.message };
        trial.elapsedMs = performance.now() - started;
        stop = opt.mode === "live";
      } finally {
        if (inputPath) await rm(inputPath, { force: true });
      }
      if (opt.mode === "live") await retainConfigurations(output, manifest, trial);
      const grade = gradeTrial(spec, trial);
      await save(join(output, "trials", `${trial.id}.json`), trial);
      await save(join(output, "imports", `${trial.id}.json`), toArtifact(manifest, trial, grade));
      trials.push(trial);
      if (stop) break;
    }
    const summary = summarize(manifest, trials);
    await save(join(output, "summary.json"), summary);
    await writeFile(
      join(output, "summary.txt"),
      `${summary.measurement}\nTrials: ${summary.completedTrials}/${summary.plannedTrials}\nIntended targets: ${summary.firstAttempt.metrics.targetsCorrect}/${summary.firstAttempt.metrics.targetsExpected}\nQualification: incomplete\nUnavailable: ${summary.unavailable.join(", ")}\n`,
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      JSON.stringify(
        {
          output,
          completed: summary.completedTrials,
          planned: summary.plannedTrials,
          targets: summary.firstAttempt.metrics.targetsCorrect,
          qualification: "incomplete",
          reportedUsd: summary.firstAttempt.cost.reportedUsd,
        },
        null,
        2,
      ),
    );
    return summary.passed ? 0 : 1;
  } finally {
    if (lock) await rm(lock, { recursive: true });
  }
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
