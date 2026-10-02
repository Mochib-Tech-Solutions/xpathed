import { normalize } from "./offline.mjs";
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
} from "../run.mjs";
import { gradeTrial, summarize } from "../grader.mjs";

const profiles = JSON.parse(await readFile(new URL("../profiles.json", import.meta.url), "utf8"));
export const datasetProfiles = [
  ...profiles,
  {
    ...profiles.find((profile) => profile.id === "deepseek"),
    id: "deepseek-deepinfra",
    provider: "deepinfra/fp8",
  },
  {
    ...profiles.find((profile) => profile.id === "luna"),
    id: "luna-azure",
    provider: "azure",
  },
];

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

export function options(args) {
  const result = {
    mode: "deterministic",
    limit: 30,
    seed: 1,
    budgetPolicy: "provider-limit",
    split: "train",
    profile: "deepseek",
    promptVariant: "baseline",
  };
  const keys = {
    "--import": "import",
    "--output": "output",
    "--mode": "mode",
    "--limit": "limit",
    "--seed": "seed",
    "--replay": "replay",
    "--budget-policy": "budgetPolicy",
    "--split": "split",
    "--reviewed-inputs": "reviewedInputs",
    "--profile": "profile",
    "--prompt-variant": "promptVariant",
    "--prepared-plan": "preparedPlan",
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
  if (
    !datasetProfiles.some(
      (profile) => profile.id === result.profile && profile.variant === "baseline",
    )
  )
    throw new Error("Offline evaluation requires an approved baseline profile");
  if (!["baseline", "intent-cardinality"].includes(result.promptVariant))
    throw new Error("Unknown offline prompt variant");
  if (result.mode !== "live" && result.promptVariant !== "baseline")
    throw new Error("Experimental prompt variants require live mode");
  if (result.preparedPlan && result.mode !== "live")
    throw new Error("Prepared plans require live mode");
  if (result.budgetPolicy !== "provider-limit")
    throw new Error("Only provider-limit accounting is supported");
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
              "Offline resolver process did not return evidence; its provider charge remains unknown",
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
      "Offline resolver returned malformed evidence; its provider charge remains unknown",
    );
  }
}

export function profileEnvironment(
  profile,
  baseUrl,
  inherited = process.env,
  promptVariant = "baseline",
) {
  const env = {
    ...inherited,
    OpenRouter__ApiKey: "dataset-proxy-only",
    OpenRouter__BaseUrl: baseUrl,
    OpenRouter__Model: profile.model,
    OpenRouter__Provider: profile.provider,
    OpenRouter__TimeoutSeconds: "30",
    XPATHED_EVALUATION_PROMPT_VARIANT: promptVariant,
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
  const valid = validProviderCalls(calls, generations);
  if (!valid)
    trial.error ??= {
      code: "provider_evidence_invalid",
      message:
        "Provider identity, response reuse or inference evidence failed; further calls stopped",
    };
  return valid;
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
  const preparedPlan = opt.preparedPlan ? await json(resolve(opt.preparedPlan)) : null;
  if (
    opt.preparedPlan &&
    (!preparedPlan ||
      preparedPlan.version !== 1 ||
      preparedPlan.profileId !== opt.profile ||
      preparedPlan.promptVariant !== opt.promptVariant ||
      !Array.isArray(preparedPlan.entries) ||
      preparedPlan.entries.length !== cases.length ||
      new Set(preparedPlan.entries.map((entry) => entry?.caseId)).size !== cases.length ||
      preparedPlan.entries.some(
        (entry) =>
          !entry ||
          !ids.includes(entry.caseId) ||
          !/^[a-f0-9]{64}$/.test(entry.inputHash) ||
          !/^[a-f0-9]{64}$/.test(entry.requestSha256) ||
          (entry.maximumUsd !== null &&
            (!Number.isFinite(entry.maximumUsd) || entry.maximumUsd < 0)) ||
          entry.inputHash !==
            reviews.entries.find((review) => review.caseId === entry.caseId)?.inputHash,
      ))
  )
    throw new Error(
      "Prepared plan must match the exact selected cases, reviewed inputs, profile, prompt and valid optional cost estimates",
    );
  const plan = buildPlan(cases, planOptions);
  plan.trials = plan.trials.map((item) => ({ ...item, id: randomUUID().replaceAll("-", "") }));
  const manifest = {
    version: "1",
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    mode: opt.mode,
    track: "offline-selection",
    profile:
      opt.mode === "live" ? datasetProfiles.find((profile) => profile.id === opt.profile) : null,
    promptVariant: opt.mode === "live" ? opt.promptVariant : null,
    preparedPlan,
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
      // Deterministic runs do not need a provider proxy.
      const { createBudgetProxy } = await import("../provider.mjs");
      const profile = manifest.profile;
      await mkdir(join(output, "provider"));
      proxy = await createBudgetProxy({
        profiles: [profile],
        budgetPolicy: opt.budgetPolicy,
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
      env = profileEnvironment(
        profile,
        `http://127.0.0.1:${proxy.server.address().port}/api/v1/`,
        process.env,
        opt.promptVariant,
      );
      manifest.policy.budgetPolicy = opt.budgetPolicy;
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
          const allocation = preparedPlan?.entries.find((entry) => entry.caseId === spec.id);
          let preparedRequest;
          if (allocation) {
            preparedRequest = structuredClone(prepared.effective.request);
            preparedRequest.messages[1].content = prepared.modelInput;
            preparedRequest.stream = false;
            if (
              preparedRequest.model !== manifest.profile.model ||
              hash(JSON.stringify(input)) !== allocation.inputHash ||
              hash(JSON.stringify(preparedRequest)) !== allocation.requestSha256
            )
              throw new Error("Prepared provider request differs from its approved plan");
          }
          proxy.beginAttempt(trial.id, opt.profile, allocation?.maximumUsd, preparedRequest);
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
