import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { readCollection } from "./datasets/collection.mjs";
import { executeOffline } from "./datasets/offline.mjs";
import {
  parseOptions,
  validateCases,
  buildPlan,
  fingerprints,
  configurationRecord,
} from "./run.mjs";
import { gradeTrial, summarize } from "./grader.mjs";
import { createBudgetProxy } from "./provider.mjs";
import profiles from "./profiles.json" with { type: "json" };

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });

export function selectModelCases(caseId, collection = readCollection()) {
  const cases = validateCases({ version: "1", cases: collection });
  if (
    cases.some(
      (item) =>
        item.track !== "offline-selection" ||
        item.review?.status !== "reviewed" ||
        item.review.providerSubmission !== true ||
        !item.review.reviewer?.trim() ||
        !Number.isFinite(Date.parse(item.review.reviewedAt)) ||
        hash(item.input) !== item.review.inputHash,
    )
  )
    throw new Error("Model evaluation requires reviewed offline selection inputs");
  const selected = caseId ? cases.filter((item) => item.id === caseId) : cases;
  if (!selected.length) throw new Error("No matching model-selection cases");
  return selected;
}

export async function runModelEvaluation(options, cases, proxy) {
  const output = options.output;
  const plan = buildPlan(cases, options);
  plan.trials = plan.trials.map((trial) => ({ ...trial, id: randomUUID().replaceAll("-", "") }));
  const manifest = {
    version: "1",
    kind: "model-selection",
    track: "offline-selection",
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    mode: "live",
    cases,
    plan,
    code: await fingerprints(),
    sourceManifestHash: hash(cases),
    resolverImage: process.env.XPATHED_MODEL_IMAGE,
    profiles,
    pricing: proxy.profiles[0].pricing,
    measurement: { latency: "Resolver CLI inference process, preparation excluded" },
    unavailable: ["live XPath identity", "current viewport", "readiness", "plural completeness"],
    policy: { qualification: "incomplete", retentionDays: 90, evidenceDays: 30 },
  };
  manifest.contentHash = hash(manifest);
  await mkdir(join(output, "trials"), { recursive: true, mode: 0o700 });
  await save(join(output, "manifest.json"), manifest);
  const trials = [];
  let runError;
  try {
    for (const planned of plan.trials) {
      const spec = cases.find((item) => item.id === planned.caseId);
      const trial = { ...planned, mode: "live", createdAt: new Date().toISOString() };
      proxy.beginAttempt(trial.id, profiles[0].id);
      await executeOffline(spec, trial, output, options.timeoutMs, false);
      await proxy.awaitIdle();
      const calls = proxy.records.filter((record) => record.attemptId === trial.id);
      trial.provider = calls.map(({ request, response, ...metadata }) => metadata);
      trial.evidence = { ...trial.evidence, provider: calls };
      trial.configuration = configurationRecord(trial);
      if (calls.some((call) => call.identityValid === false || call.responseCacheHit))
        trial.error = {
          code: "invalid_provider_evidence",
          message: "Provider identity or response reuse invalid",
        };
      trial.grade = gradeTrial(spec, trial);
      await save(join(output, "trials", `${trial.id}.json`), trial);
      trials.push(trial);
      console.log(`${trial.grade.passed ? "PASS" : "FAIL"} ${trial.caseId}`);
      if (trial.error) throw new Error(trial.error.message);
    }
  } catch (error) {
    runError = { message: error.message };
    await save(join(output, "run-error.json"), runError);
  }
  const summary = summarize(manifest, trials);
  if (runError) {
    summary.passed = false;
    summary.stopFurtherInference = true;
  }
  await save(join(output, "summary.json"), summary);
  const first = summary.firstAttempt;
  const text =
    [
      "Model target-selection evaluation (live inference, saved page inputs)",
      `Trials: ${summary.completedTrials}/${summary.plannedTrials}; passed: ${first.passed}; failed: ${first.failed}`,
      `Reported cost: ${first.cost.reportedUsd.total ?? "unavailable"} USD; unknown charges: ${first.cost.reportedUsd.unavailable}`,
      "Live XPath and readiness are outside this track. This run does not approve a release.",
      ...(runError ? [runError.message] : []),
    ].join("\n") + "\n";
  await writeFile(join(output, "summary.txt"), text, { flag: "wx" });
  console.log(text);
  return summary.passed ? 0 : 1;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (
    options.mode !== "live" ||
    options.repetitions !== 1 ||
    options.concurrency !== 1 ||
    options.replay ||
    options.prune
  )
    throw new Error(
      "Model evaluation requires live mode and one attempt per case; use evaluate:replay for saved results",
    );
  const cases = selectModelCases(options.caseId);
  await mkdir(join(options.output, "provider"), { recursive: true, mode: 0o700 });
  const proxy = await createBudgetProxy({
    profiles,
    ledgerPath: join(options.output, "accounting.json"),
    onRecord: (record) =>
      writeFile(
        join(options.output, "provider", `${record.id}.json`),
        JSON.stringify(record, null, 2) + "\n",
        { mode: 0o600 },
      ),
  });
  try {
    proxy.server.listen(8091, "0.0.0.0");
    await once(proxy.server, "listening");
    return await runModelEvaluation(options, cases, proxy);
  } finally {
    await proxy.close();
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
