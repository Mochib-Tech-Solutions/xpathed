import { retiredReleaseCommit } from "./release-transition.mjs";
import { readCollection, validateLabelReview } from "./datasets/collection.mjs";
import { loadCases } from "./cases/load.mjs";
import { executeOffline } from "./datasets/offline.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";
import {
  parseOptions,
  buildPlan,
  validateCases,
  execute,
  fingerprints,
  configurationRecord,
} from "./run.mjs";
import { compareTrials, compareMeasurements, measuredEntry } from "./comparison.mjs";
import { gradeTrial } from "./grader.mjs";
import defaultPolicy from "./policy.json" with { type: "json" };

const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
// Keep the completed first arm even if the second arm cannot reserve or finish.
export async function savePairedTrial(directory, trial, runBaseline) {
  const path = join(directory, `${trial.id}.json`);
  await save(path, trial);
  if (!runBaseline || trial.error?.code === "unreviewed_prepared_input") return;
  const update = async () => {
    await writeFile(`${path}.partial`, JSON.stringify(trial, null, 2) + "\n", { mode: 0o600 });
    await rename(`${path}.partial`, path);
  };
  try {
    trial.baseline = await runBaseline(async (baseline) => {
      trial.baseline = baseline;
      await update();
    });
  } finally {
    await update();
  }
}

import { profiles } from "./configuration.mjs";
export { profiles };

export function validateReleaseArtifact(artifact, sourceSha, profileIds) {
  const keys = (value, expected) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
  if (
    !keys(artifact, [
      "version",
      "bundleManifestSha256",
      "sourceSha",
      "profileId",
      "images",
      "platform",
    ]) ||
    artifact.version !== 1 ||
    !/^[a-f\d]{64}$/.test(artifact.bundleManifestSha256 ?? "") ||
    !/^[a-f\d]{40}$/.test(artifact.sourceSha ?? "") ||
    artifact.sourceSha !== sourceSha ||
    !isDeepStrictEqual(profileIds, [artifact.profileId]) ||
    !profiles.some((profile) => profile.id === artifact.profileId) ||
    !keys(artifact.platform, ["os", "architecture"]) ||
    artifact.platform.os !== "linux" ||
    !["amd64", "arm64"].includes(artifact.platform.architecture) ||
    !Array.isArray(artifact.images) ||
    artifact.images.length !== 2 ||
    new Set(artifact.images.map((image) => image?.id)).size !== 2 ||
    !artifact.images.every(
      (image, index) =>
        keys(image, ["component", "id", "os", "architecture", "sourceSha"]) &&
        image.component === ["browser", "resolver"][index] &&
        /^sha256:[a-f\d]{64}$/.test(image.id ?? "") &&
        image.os === artifact.platform.os &&
        image.architecture === artifact.platform.architecture &&
        image.sourceSha === artifact.sourceSha,
    )
  )
    throw new Error("Invalid release artifact identity, source or selected profile");
  return artifact;
}

export function parseQualificationOptions(args) {
  const extra = { monitoring: false };
  const rest = [],
    seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].slice(2);
    if (["suite", "monitoring"].includes(name)) {
      if (seen.has(name) || !args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error("Repeated or missing comparison option");
      seen.add(name);
      extra[name] = args[i + 1];
    } else rest.push(args[i], args[i + 1]);
  }
  const options = { ...parseOptions(rest), ...extra };
  if (options.concurrency !== 1) throw new Error("Comparison requires concurrency 1");
  if (options.replay && seen.size) throw new Error("Replay cannot be combined with run options");
  if (options.prune || options.repetitions !== 1)
    throw new Error("Release comparison uses one attempt per case");
  if (![false, "true"].includes(options.monitoring)) throw new Error("Use --monitoring true");
  options.monitoring = options.monitoring === "true";
  options.profileIds = [profiles[0].id];
  return options;
}

export function selectQualificationCases(cases, options = {}) {
  const selected = [],
    exclusions = [];
  for (const item of cases) {
    const review = item.track === "offline-selection" ? validateLabelReview(item) : undefined;
    const reason =
      review && review.disposition !== "validated"
        ? `label ${review.disposition}: ${review.reason}`
        : options.caseId && options.caseId !== item.id
          ? "case filter"
          : item.mutation
            ? "saved-locator CI coverage"
            : item.provider?.fault || item.deterministicOnly || item.expected?.outcome === "error"
              ? "deterministic fault coverage"
              : null;
    if (reason) exclusions.push({ caseId: item.id, reason });
    else selected.push(item);
  }
  if (!selected.length) throw new Error("No eligible release cases");
  return { cases: selected, exclusions };
}

export function buildMatrixPlan(cases, selectedProfiles, options) {
  const plan = buildPlan(cases, options);
  return {
    ...plan,
    trials: plan.trials.flatMap((trial) =>
      selectedProfiles.map((profile) => ({ ...trial, profileId: profile.id })),
    ),
    order: "Seeded case order; one original attempt per arm; no retries",
  };
}

export async function readRun(directory) {
  const manifest = await json(join(directory, "manifest.json"));
  const { contentHash, ...body } = manifest;
  if (hash(body) !== contentHash || manifest.kind !== "model-qualification")
    throw new Error("Qualification manifest integrity mismatch");
  if (Object.hasOwn(manifest.qualification ?? {}, "artifact"))
    validateReleaseArtifact(
      manifest.qualification.artifact,
      manifest.code?.revision,
      manifest.profiles?.map((p) => p.id),
    );
  for (const path of [
    "evaluation/compare.mjs",
    "evaluation/grader.mjs",
    "evaluation/policy.mjs",
    "evaluation/comparison.mjs",
  ])
    if (
      manifest.code.files[path] !==
      hash(await readFile(new URL(`../${path}`, import.meta.url), "utf8"))
    )
      throw new Error(`Replay requires the recorded revision: ${path}`);
  validateCases({
    version: "1",
    cases: manifest.cases,
    ...(manifest.baseline ? { baseline: manifest.baseline } : {}),
  });
  const trials = [];
  for (const planned of manifest.plan.trials) {
    try {
      const trial = await json(join(directory, "trials", `${planned.id}.json`));
      if (
        ["id", "caseId", "profileId", "repetition", "attempt"].some(
          (key) => trial[key] !== planned[key],
        )
      )
        throw new Error("Qualification trial identity mismatch");
      trials.push(trial);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { manifest, trials };
}

export function summarizeMonitoring(manifest, trials, baseline) {
  if (manifest.monitoring !== true || manifest.mode !== "live")
    throw new Error("Monitoring requires a frozen live run");
  const entries = manifest.cases.map((spec) =>
    measuredEntry(
      spec,
      trials.find((trial) => trial.caseId === spec.id),
      manifest.profiles[0],
      manifest.policy,
    ),
  );
  const generations = new Set();
  for (const entry of entries) {
    const id = entry.generationId;
    if (typeof id !== "string" || !id.trim() || generations.has(id)) entry.operational = true;
    generations.add(id);
  }
  const report = compareMeasurements(entries, baseline);
  if (trials.length !== entries.length) report.status = "infrastructure_failure";
  return { ...report, entries };
}

function printSummary(summary) {
  for (const [profileId, report] of Object.entries(summary.profiles)) {
    const first = report.firstAttempt;
    console.log(
      `${profileId}: ${first.passed}/${report.plannedTrials} checks passed; p50/p95 ${first.latencyMs.p50 ?? "n/a"}/${first.latencyMs.p95 ?? "n/a"}ms; reported USD ${first.cost.reportedUsd.total ?? "unavailable"}; ${report.qualification.status} (${report.qualification.reasons.join(", ") || "all gates passed"})`,
    );
  }
  console.log(
    `Qualified candidates: ${summary.qualifiedCandidates.join(", ") || "none"}; runtime default unchanged.`,
  );
}

export function fixtureProxy(fixture, timeoutMs) {
  return createServer(async (req, res) => {
    try {
      // Preparation must not seed the Resolver cache with synthetic endpoint prices.
      if (req.method === "GET" && req.url?.endsWith("/endpoints")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2_000_000) throw new Error("Request too large");
        chunks.push(chunk);
      }
      const upstream = await fetch(`${fixture}${req.url}`, {
        method: req.method,
        headers: { "Content-Type": "application/json" },
        body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(await upstream.text());
    } catch {
      res.writeHead(502);
      res.end();
    }
  });
}

export async function main(args = process.argv.slice(2)) {
  const options = parseQualificationOptions(args);
  const { summarizeQualification } = await import("./policy.mjs");
  if (options.replay) {
    const run = await readRun(resolve(options.replay));
    const summary = summarizeQualification(run.manifest, run.trials, run.manifest.policy);
    printSummary(summary);
    return summary.qualifiedCandidates.length ? 0 : 1;
  }
  const selectedProfiles = options.profileIds.map((id) => profiles.find((p) => p.id === id));
  const comparison = process.env.XPATHED_RELEASE_COMPARISON_JSON
    ? JSON.parse(process.env.XPATHED_RELEASE_COMPARISON_JSON)
    : undefined;
  const initialBaseline = process.env.XPATHED_INITIAL_BASELINE;
  if (
    initialBaseline &&
    (initialBaseline !== retiredReleaseCommit || comparison || options.monitoring)
  )
    throw new Error("Invalid initial baseline transition");
  if (options.mode === "live" && !options.monitoring && !comparison && !initialBaseline)
    throw new Error("Release comparison requires the published baseline images");
  if (comparison && (selectedProfiles.length !== 1 || options.monitoring))
    throw new Error("Use one candidate and one baseline; monitoring runs only the released arm");
  if (comparison)
    validateReleaseArtifact(comparison.artifact, comparison.artifact.sourceSha, [
      comparison.profile.id,
    ]);
  const code = await fingerprints();
  const artifact = process.env.XPATHED_RELEASE_ARTIFACT_JSON
    ? validateReleaseArtifact(
        JSON.parse(process.env.XPATHED_RELEASE_ARTIFACT_JSON),
        code.revision,
        options.profileIds,
      )
    : undefined;
  const suite = loadCases(
    options.suite ||
      process.env.XPATHED_EVALUATION_SUITE ||
      new URL("./cases/index.json", import.meta.url),
  );
  suite.cases.push(...readCollection());
  const allCases = validateCases(suite);
  const { cases, exclusions } = selectQualificationCases(allCases, options);
  if (!artifact && cases.some((spec) => spec.track === "offline-selection"))
    throw new Error(
      "Use release:evaluate with a verified image bundle to start the offline Resolver worker",
    );
  if (
    options.mode === "live" &&
    cases.some(
      (spec) =>
        spec.review?.status !== "reviewed" ||
        !spec.review.reviewer?.trim() ||
        !Number.isFinite(Date.parse(spec.review.reviewedAt)),
    )
  )
    throw new Error("Live evaluation requires independently reviewed expectations");
  const output = resolve(options.output);
  await mkdir(join(output, "trials"), { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const manifest = {
    version: "1",
    kind: "model-qualification",
    id: randomUUID(),
    createdAt: now,
    mode: options.mode,
    ...(options.monitoring ? { monitoring: true } : {}),
    cases,
    exclusions,
    sourceManifestHash: hash(suite),
    profiles: selectedProfiles,
    ...(comparison ? { comparison } : {}),
    ...(process.env.XPATHED_INITIAL_BASELINE
      ? { initialBaseline: process.env.XPATHED_INITIAL_BASELINE }
      : {}),
    plan: buildMatrixPlan(cases, selectedProfiles, options),
    code,
    browserBinarySha256: process.env.XPATHED_BROWSER_BINARY_SHA256 ?? null,
    policy: defaultPolicy,
    qualification: {
      ...(artifact ? { artifact } : {}),
      policySha256: hash(defaultPolicy),
      frozenAt: now,
    },
    measurement: {
      latencyProtocol: "resolver-http",
      latency:
        "Browser: complete Resolver HTTP response, independent setup and grading excluded. Offline: Resolver CLI inference process, preparation excluded.",
      serving: "standard",
      responseReuse: false,
      healing: false,
      actionExecution: false,
      retentionDays: 90,
      evidenceDays: 30,
    },
  };
  manifest.plan.trials = manifest.plan.trials.map((trial) => ({
    ...trial,
    id: randomUUID().replaceAll("-", ""),
  }));
  const services = {
    browser: process.env.XPATHED_BROWSER_URL ?? "http://browser:8080",
    fixture: process.env.XPATHED_FIXTURE_URL ?? "http://evaluation-fixture:8090",
  };
  const inferenceProfiles = comparison
    ? [
        ...selectedProfiles,
        {
          ...comparison.profile,
          id: "release-baseline",
          resolver: "http://resolver-baseline:8080",
        },
      ]
    : selectedProfiles;
  const trials = [];
  let proxy, deterministicProxy, runError;
  async function runTrial(spec, planned, reference = false, retain) {
    const profile = inferenceProfiles.find((profile) => profile.id === planned.profileId);
    const trial = {
      ...planned,
      mode: options.mode,
      createdAt: new Date().toISOString(),
      result: null,
      evidence: null,
    };
    if (retain) await retain(trial);
    if (options.mode === "live") proxy.beginAttempt(trial.id, profile.id);
    if (spec.track === "offline-selection")
      await executeOffline(spec, trial, output, options.timeoutMs, reference);
    else
      await execute(spec, trial, options, {
        ...services,
        ...(reference ? { browser: "http://browser-baseline:8080" } : {}),
        resolver: profile.resolver,
      });
    trial.configuration = configurationRecord(trial);
    if (options.mode === "live") {
      await proxy.awaitIdle();
      const calls = proxy.records.filter((record) => record.attemptId === trial.id);
      trial.provider = calls.map(({ request, response, ...metadata }) => metadata);
      trial.evidence = { ...trial.evidence, provider: calls };
    }
    trial.grade = gradeTrial(spec, trial);
    if (!reference)
      await savePairedTrial(
        join(output, "trials"),
        trial,
        comparison
          ? (retain) =>
              runTrial(
                spec,
                {
                  ...planned,
                  id: hash(`${planned.id}:baseline`).slice(0, 32),
                  profileId: "release-baseline",
                },
                true,
                retain,
              )
          : null,
      );
    return trial;
  }
  try {
    if (options.mode === "live") {
      const { createBudgetProxy } = await import("./provider.mjs");
      await mkdir(join(output, "provider"));
      proxy = await createBudgetProxy({
        profiles: inferenceProfiles,
        ledgerPath:
          process.env.XPATHED_BUDGET_PATH ?? resolve(".artifacts/datasets/experiment-budget.json"),
        onRecord: (record) =>
          writeFile(
            join(output, "provider", `${record.id}.json`),
            JSON.stringify(record, null, 2) + "\n",
            { mode: 0o600 },
          ),
      });
      manifest.accounting = { version: 1, budgetPolicy: "provider-limit" };
      manifest.pricing = Object.fromEntries(
        proxy.profiles.map((profile) => [profile.id, profile.pricing]),
      );
      proxy.server.listen(8091, "0.0.0.0");
      await once(proxy.server, "listening");
    } else {
      deterministicProxy = fixtureProxy(services.fixture, options.timeoutMs);
      deterministicProxy.listen(8091, "0.0.0.0");
      await once(deterministicProxy, "listening");
    }
    manifest.contentHash = hash(manifest);
    await save(join(output, "manifest.json"), manifest);
    for (const planned of manifest.plan.trials) {
      const trial = await runTrial(
        cases.find((spec) => spec.id === planned.caseId),
        planned,
      );
      trials.push(trial);
      console.log(
        `${trial.grade.passed ? "PASS" : "FAIL"} ${trial.profileId} ${trial.caseId} ${Math.round(trial.elapsedMs ?? 0)}ms`,
      );
      if ([trial, trial.baseline].some((arm) => arm?.error?.code === "unreviewed_prepared_input"))
        throw new Error("Prepared input review integrity violation");
      if (
        [...(trial.provider ?? []), ...(trial.baseline?.provider ?? [])].some(
          (call) => call.identityValid === false || call.responseCacheHit,
        )
      )
        throw new Error("Provider identity or response reuse invalid");
    }
  } catch (error) {
    runError = { message: error.message };
    await save(join(output, "run-error.json"), runError);
    if (!manifest.contentHash) {
      manifest.contentHash = hash(manifest);
      await save(join(output, "manifest.json"), manifest);
    }
  } finally {
    await proxy?.close();
    if (deterministicProxy) await new Promise((resolve) => deterministicProxy.close(resolve));
  }
  const summary = summarizeQualification(manifest, trials, defaultPolicy);
  await save(join(output, "summary.json"), summary);
  printSummary(summary);
  // Monitoring compares with its saved measurements in the host, after container attestation.
  return runError || trials.length !== manifest.plan.trials.length
    ? 1
    : options.monitoring
      ? 0
      : options.mode === "live"
        ? summary.qualifiedCandidates.length
          ? 0
          : 1
        : trials.some((trial) => !trial.grade.passed)
          ? 1
          : 0;
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
