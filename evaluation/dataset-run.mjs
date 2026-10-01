import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import {
  buildPlan,
  fingerprints,
  replay,
  toArtifact,
  validateCases,
  retainConfigurations,
} from "./run.mjs";
import { gradeTrial, summarize } from "./grader.mjs";

const profiles = JSON.parse(
  await readFile(new URL("./qualification-profiles.json", import.meta.url), "utf8"),
);

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

export function assertReconciledCharges(ledger) {
  if (
    ledger.entries.some(
      (entry) => entry.reportedUsd == null || entry.reportedUsd > entry.reservedUsd,
    )
  )
    throw new Error("Unreconciled prior attempt blocks further paid calls");
}

export function options(args) {
  const result = {
    mode: "deterministic",
    limit: 30,
    seed: 1,
    budgetUsd: 5,
    split: "train",
    profile: "deepseek",
  };
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
    "--profile": "profile",
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
  if (!profiles.some((profile) => profile.id === result.profile && profile.variant === "baseline"))
    throw new Error("Offline evaluation requires an approved baseline profile");
  result.budgetUsd = Number(result.budgetUsd);
  if (!(result.budgetUsd > 0 && result.budgetUsd <= 5))
    throw new Error("Initial experiment ceiling must be at most $5 total");
  return result;
}

export async function cli(path, env, prepareOnly = false) {
  // Keep the event loop available for the shared budget proxy while .NET runs.
  const stdout = await new Promise((resolve, reject) => {
    execFile(
      "dotnet",
      [
        "src/Resolver/bin/Release/net10.0/Resolver.dll",
        "--evaluate-offline",
        path,
        ...(prepareOnly ? ["--prepare-only"] : []),
      ],
      { env, encoding: "utf8", timeout: 65000, maxBuffer: 2_000_000 },
      (error, stdout) => {
        if (!stdout?.trim() || error?.killed || error?.code === "ENOENT")
          reject(
            new Error(
              "Offline resolver process did not return evidence; its reserved cost remains charged",
            ),
          );
        else resolve(stdout);
      },
    );
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      "Offline resolver returned malformed evidence; its reserved cost remains charged",
    );
  }
}

export function profileEnvironment(profile, baseUrl, inherited = process.env) {
  const env = {
    ...inherited,
    OpenRouter__ApiKey: "dataset-proxy-only",
    OpenRouter__BaseUrl: baseUrl,
    OpenRouter__Model: profile.model,
    OpenRouter__Provider: profile.provider,
    OpenRouter__TimeoutSeconds: "30",
  };
  delete env.OpenRouter__ReasoningEffort;
  delete env.OpenRouter__PromptCacheMode;
  delete env.XPATHED_EVALUATION_PRICE_LIMITS;
  if (profile.reasoning.effort) env.OpenRouter__ReasoningEffort = profile.reasoning.effort;
  if (profile.promptCacheOptions) env.OpenRouter__PromptCacheMode = profile.promptCacheOptions.mode;
  return env;
}

export function retainProviderEvidence(trial, records) {
  const calls = records.filter((record) => record.attemptId === trial.id);
  trial.provider = calls.map(({ request, response, ...metadata }) => metadata);
  trial.evidence = { ...trial.evidence, provider: calls };
}

export function validProviderCalls(calls, generations) {
  if (calls.length !== 1 || calls[0].forwarded !== true) return false;
  const record = calls[0];
  const generation = record.observedIdentity?.generationId;
  if (
    record.identityValid !== true ||
    record.responseCacheHit ||
    record.error ||
    !generation ||
    generations.has(generation)
  )
    return false;
  generations.add(generation);
  return true;
}

export async function finishProviderAttempt(trial, proxy, generations) {
  await proxy.awaitIdle();
  retainProviderEvidence(trial, proxy.records);
  const calls = proxy.records.filter((record) => record.attemptId === trial.id);
  const valid = proxy.budget.pendingCharges === 0 && validProviderCalls(calls, generations);
  if (!valid)
    trial.error ??= {
      code: "provider_evidence_invalid",
      message: "Provider identity, response reuse or charge evidence failed; further calls stopped",
    };
  return valid;
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
  if (opt.mode === "live") {
    const build = spawnSync(
      "dotnet",
      ["build", "src/Resolver/Resolver.csproj", "--configuration", "Release", "--no-restore"],
      { encoding: "utf8", timeout: 60000, maxBuffer: 2_000_000 },
    );
    if (build.error || build.status !== 0)
      throw new Error(
        "Build the current Resolver successfully before evaluating; run pnpm restore:dotnet if needed",
      );
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
    profile: opt.mode === "live" ? profiles.find((profile) => profile.id === opt.profile) : null,
    timingScope:
      "Offline preparation and resolver child-process startup plus model selection; no browser or UI latency",
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
  let proxy, env;
  try {
    if (opt.mode === "live") {
      // Import lazily: the shared proxy uses this module's reservation helpers.
      const { createBudgetProxy } = await import("./comparison-budget.mjs");
      const profile = manifest.profile;
      await mkdir(join(output, "provider"));
      proxy = await createBudgetProxy({
        profiles: [profile],
        ceilingUsd: opt.budgetUsd,
        onRecord: (record) =>
          writeFile(
            join(output, "provider", `${record.id}.json`),
            JSON.stringify(record, null, 2) + "\n",
            { mode: 0o600 },
          ),
      });
      await new Promise((resolve, reject) => {
        proxy.server.once("error", reject);
        proxy.server.listen(0, "127.0.0.1", resolve);
      });
      manifest.pricing = proxy.pricing;
      manifest.routeMetadata = proxy.profiles;
      manifest.budgetBefore = proxy.budget;
      env = profileEnvironment(profile, `http://127.0.0.1:${proxy.server.address().port}/api/v1/`);
      manifest.policy.experimentCeilingUsd = proxy.budget.ceilingUsd;
    }
    manifest.contentHash = hash(JSON.stringify(manifest));
    await save(join(output, "manifest.json"), manifest);
    const trials = [];
    const generations = new Set();
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
      let inferenceStarted = false;
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
          const prepared = await cli(inputPath, env, true);
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
          proxy.beginAttempt(trial.id, opt.profile);
          inferenceStarted = true;
          result = await cli(inputPath, env);
        } else result = lexicalSelection(input);
        trial.result = normalize(result, trial.id);
        trial.elapsedMs = performance.now() - started;
      } catch (error) {
        trial.error = { code: "dataset_trial_error", message: error.message };
        trial.elapsedMs = performance.now() - started;
        stop = opt.mode === "live";
      } finally {
        if (inferenceStarted)
          stop = !(await finishProviderAttempt(trial, proxy, generations)) || stop;
        if (inputPath) await rm(inputPath, { force: true });
      }
      if (opt.mode === "live") await retainConfigurations(output, manifest, trial);
      const grade = gradeTrial(spec, trial);
      await save(join(output, "trials", `${trial.id}.json`), trial);
      await save(join(output, "imports", `${trial.id}.json`), toArtifact(manifest, trial, grade));
      trials.push(trial);
      if (opt.mode === "live")
        console.log(
          `${grade.passed ? "PASS" : "FAIL"} ${opt.profile} ${spec.id} ${Math.round(trial.elapsedMs)}ms (${trials.length}/${plan.trials.length})`,
        );
      if (stop) break;
    }
    if (proxy) await save(join(output, "budget.json"), proxy.budget);
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
    await proxy?.close();
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
