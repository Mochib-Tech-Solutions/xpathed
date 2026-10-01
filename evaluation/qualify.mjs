import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { gradeTrial } from "./grader.mjs";
import defaultPolicy from "./qualification-policy.json" with { type: "json" };

const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
export const profiles = await json(new URL("./qualification-profiles.json", import.meta.url));

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
  const extra = { phase: "pilot", split: "development", profile: "luna,gemini,deepseek" };
  const rest = [],
    seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].slice(2);
    if (
      ["phase", "split", "profile", "pilot", "suite", "forecast-only", "sentinels"].includes(name)
    ) {
      if (seen.has(name) || !args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error("Repeated or missing qualification option");
      seen.add(name);
      extra[name] = args[i + 1];
    } else rest.push(args[i], args[i + 1]);
  }
  const options = { ...parseOptions(rest), ...extra };
  if (options["forecast-only"] !== undefined && options["forecast-only"] !== "true")
    throw new Error("Use --forecast-only true for explicit preparation");
  options.forecastOnly = options["forecast-only"] === "true";
  delete options["forecast-only"];
  if (options.forecastOnly && options.mode !== "live")
    throw new Error("Forecast preparation requires live pricing mode");
  if (options.prune) throw new Error("Use the ordinary evaluation prune command");
  if (options.replay && seen.size)
    throw new Error("Replay cannot be combined with qualification options");
  options.splits = options.split.split(",");
  options.profileIds = options.profile.split(",");
  if (options.sentinels !== undefined && options.sentinels !== "true")
    throw new Error("Use --sentinels true for the frozen monitoring subset");
  options.sentinels = options.sentinels === "true";
  if (
    options.splits.some((s) => !["development", "regression", "held-out"].includes(s)) ||
    new Set(options.splits).size !== options.splits.length
  )
    throw new Error("Invalid or duplicate qualification split");
  if (
    options.profileIds.some((id) => !profiles.some((p) => p.id === id)) ||
    new Set(options.profileIds).size !== options.profileIds.length
  )
    throw new Error("Invalid or duplicate qualification profile");
  if (!["pilot", "confirmation"].includes(options.phase))
    throw new Error("Invalid qualification phase");
  if (options.splits.includes("held-out") && options.phase !== "confirmation")
    throw new Error("Held-out cases require confirmation phase");
  if (options.phase === "confirmation" && !options.pilot)
    throw new Error("Confirmation requires a recorded pilot directory");
  if (
    options.sentinels &&
    (options.phase !== "pilot" ||
      options.repetitions !== 1 ||
      options.profileIds.length !== 1 ||
      options.caseId ||
      options.forecastOnly)
  )
    throw new Error(
      "Sentinel monitoring uses one profile, one attempt and the complete frozen subset",
    );
  return options;
}

export function selectQualificationCases(cases, options) {
  if (
    options.sentinelIds &&
    cases.some((c) => options.sentinelIds.includes(c.id) && c.split === "held-out")
  )
    throw new Error(
      "Sentinels must use development or regression cases, never fresh held-out families",
    );
  const selected = [],
    exclusions = [];
  for (const item of cases) {
    const reason =
      options.caseId && item.id !== options.caseId
        ? "case filter"
        : options.sentinelIds && !options.sentinelIds.includes(item.id)
          ? "outside frozen sentinel subset"
          : !options.splits.includes(item.split)
            ? "split filter"
            : options.requiredContractVersion &&
                item.contractVersion !== options.requiredContractVersion
              ? "legacy contract compatibility track"
              : !["3", "4"].includes(item.contractVersion)
                ? "legacy contract regression track"
                : item.track === "offline-selection"
                  ? "offline dataset track"
                  : item.mutation
                    ? "saved-locator mutation regression track"
                    : options.mode === "live" &&
                        (item.provider?.fault ||
                          item.deterministicOnly ||
                          item.expected?.outcome === "error")
                      ? "deterministic compatibility only"
                      : null;
    if (reason)
      exclusions.push({ caseId: item.id, family: item.family, split: item.split, reason });
    else selected.push(item);
  }
  if (!selected.length) throw new Error("No matching qualification cases");
  return { cases: selected, exclusions };
}

export function compatibilityCases(allCases, preparationCases = []) {
  return [
    ...new Map(
      [
        ...preparationCases,
        ...[
          ...new Set(
            allCases
              .filter((c) => ["3", "4"].includes(c.contractVersion))
              .map((c) => c.contractVersion),
          ),
        ].flatMap((version) => {
          const compatibility = allCases.filter(
            (c) => c.contractVersion === version && c.split !== "held-out" && !c.mutation,
          );
          const required = [
            compatibility.find((c) => c.expected.actions.some((a) => a.outcome === "found")),
            compatibility.find((c) => c.expected.actions.some((a) => a.outcome === "not_found")),
            compatibility.find(
              (c) => c.expected.actions.filter((a) => a.outcome === "found").length > 1,
            ),
          ];
          if (required.some((c) => !c))
            throw new Error(
              `Compatibility suite needs positive, absent, and plural cases for contract ${version}`,
            );
          return [...new Set([...required, ...compatibility.filter((c) => c.provider?.fault)])];
        }),
      ].map((spec) => [spec.id, spec]),
    ).values(),
  ];
}

export function buildMatrixPlan(cases, selectedProfiles, options) {
  const plan = buildPlan(cases, options);
  if (cases.some((c) => c.pairId)) {
    const specs = new Map(cases.map((c) => [c.id, c]));
    const seen = new Set();
    let pairIndex = 0;
    plan.trials = plan.trials.flatMap((trial) => {
      const pairId = specs.get(trial.caseId).pairId;
      if (!pairId) return [trial];
      const key = `${pairId}:${trial.repetition}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const members = plan.trials.filter(
        (t) => t.repetition === trial.repetition && specs.get(t.caseId).pairId === pairId,
      );
      const first = pairIndex++ % 2 === 0 ? "3" : "4";
      return members.sort(
        (a, b) =>
          Number(specs.get(b.caseId).contractVersion === first) -
          Number(specs.get(a.caseId).contractVersion === first),
      );
    });
  }
  return {
    ...plan,
    trials: plan.trials.flatMap((t, index) => {
      const offset = index % selectedProfiles.length;
      return [...selectedProfiles.slice(offset), ...selectedProfiles.slice(0, offset)].map(
        (profile) => ({ ...t, profileId: profile.id }),
      );
    }),
    order: cases.some((c) => c.pairId)
      ? "Seeded pair order, adjacent contracts alternating first position; separate edges; no retries"
      : "Seeded case order, rotating model order, sequential repetitions; no retries",
    warmup:
      "No discarded warmups; new browser session per trial; provider prompt-cache warmth uncontrolled and reported",
  };
}

export function forecastPilot(pilot, planned, prices) {
  const byProfile = {};
  for (const profileId of [...new Set(planned.map((t) => t.profileId))]) {
    const calls = pilot.trials
      .filter((t) => t.profileId === profileId)
      .flatMap((t) => t.provider ?? [])
      .filter((p) => p.forwarded);
    const price = prices[profileId]?.pricing ?? prices[profileId];
    const unavailable =
      !calls.length ||
      calls.some(
        (p) =>
          !Number.isFinite(p.usage?.prompt_tokens) ||
          p.usage.prompt_tokens < 0 ||
          !Number.isFinite(p.usage?.completion_tokens) ||
          p.usage.completion_tokens < 0,
      )
        ? "Pilot token evidence unavailable"
        : ![price?.prompt, price?.completion, price?.request ?? 0].every(
              (p) => p != null && Number.isFinite(Number(p)) && Number(p) >= 0,
            )
          ? "Current route pricing unavailable"
          : null;
    if (unavailable) {
      byProfile[profileId] = {
        samples: calls.length,
        plannedCalls: planned.filter((p) => p.profileId === profileId).length,
        projectedUsd: null,
        conservativeProjectionUsd: null,
        unavailable,
      };
      continue;
    }
    const tokens = (key) => calls.map((p) => p.usage[key]).sort((a, b) => a - b);
    const distribution = (values) => ({
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      p95: values[Math.ceil(values.length * 0.95) - 1],
      max: values.at(-1),
    });
    const input = distribution(tokens("prompt_tokens")),
      output = distribution(tokens("completion_tokens"));
    const count = planned.filter((p) => p.profileId === profileId).length;
    byProfile[profileId] = {
      samples: calls.length,
      plannedCalls: count,
      inputTokens: input,
      outputTokens: output,
      pricing: price,
      projectedUsd:
        count *
        (input.mean * Number(price.prompt) +
          output.mean * Number(price.completion) +
          Number(price.request ?? 0)),
      conservativeProjectionUsd:
        count *
        (input.max * Number(price.prompt) +
          output.max * Number(price.completion) +
          Number(price.request ?? 0)) *
        2,
    };
  }
  const projectedUsd = Object.values(byProfile).some((p) => p.conservativeProjectionUsd == null)
    ? null
    : Object.values(byProfile).reduce((sum, p) => sum + p.conservativeProjectionUsd, 0);
  return {
    basis:
      "Informational pilot token projection at current route rates; provider key limits govern spending",
    budgetPolicy: "provider-limit",
    byProfile,
    projectedUsd,
    remainingUsd: null,
    fits: null,
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
    "evaluation/qualify.mjs",
    "evaluation/grader.mjs",
    "evaluation/qualification-policy.mjs",
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

export function summarizeMonitoring(manifest, trials) {
  if (manifest.monitoring !== true || manifest.mode !== "live" || manifest.policy?.version !== "3")
    throw new Error("Monitoring requires a frozen current-view live run");
  return summarizeLiveChecks(manifest, trials);
}

export function assertPilotReady({ manifest, trials }) {
  if (
    manifest.phase !== "pilot" ||
    manifest.mode !== "live" ||
    manifest.monitoring ||
    manifest.cases.some((spec) => spec.split === "held-out" || spec.capabilityGap)
  )
    throw new Error("Confirmation requires a live development pilot without capability gaps");
  const report = summarizeLiveChecks(manifest, trials);
  if (report.status !== "passed")
    throw new Error(`Pilot failed before held-out reservation: ${report.status}`);
  return report;
}

function summarizeLiveChecks(manifest, trials) {
  const entries = manifest.plan.trials.map((planned) => {
    const matches = trials.filter(
      (trial) =>
        trial.id === planned.id &&
        trial.caseId === planned.caseId &&
        trial.profileId === planned.profileId &&
        trial.attempt === 1,
    );
    const trial = matches.length === 1 ? matches[0] : undefined;
    const spec = manifest.cases.find((item) => item.id === planned.caseId);
    const grade = gradeTrial(spec, trial);
    const calls = trial?.provider?.filter((p) => p.forwarded) ?? [];
    const operational =
      !trial ||
      Boolean(trial.accountingError) ||
      grade.metrics.operationalError ||
      calls.length !== 1 ||
      calls.some(
        (p) => p.identityValid !== true || p.responseCacheHit || !Number.isFinite(p.reportedUsd),
      );
    return {
      caseId: planned.caseId,
      passed: grade.passed && grade.metrics.processingComplete === true && !operational,
      operational: Boolean(operational),
      elapsedMs: trial?.elapsedMs ?? null,
      failures: grade.failures,
    };
  });
  const complete = entries.length > 0 && trials.length === entries.length;
  const correct = entries.filter((e) => e.passed).length;
  const onTime = entries.filter(
    (e) => e.passed && Number.isFinite(e.elapsedMs) && e.elapsedMs <= manifest.policy.deadlineMs,
  ).length;
  const status =
    !complete || entries.some((e) => e.operational)
      ? "infrastructure_failure"
      : correct !== entries.length
        ? "semantic_drift"
        : onTime / entries.length < manifest.policy.minimumCorrectCompleteWithinDeadline
          ? "latency_regression"
          : "passed";
  const charges = trials.flatMap((trial) => trial.provider ?? []).filter((p) => p.forwarded);
  return {
    status,
    planned: entries.length,
    correct,
    correctCompleteWithinDeadline: onTime,
    reportedUsd: charges.every((p) => Number.isFinite(p.reportedUsd))
      ? charges.reduce((sum, p) => sum + p.reportedUsd, 0)
      : null,
    entries,
    defaultActivated: false,
  };
}

export function baselineEvidence(pilot) {
  return {
    runId: pilot.manifest.id,
    manifestHash: pilot.manifest.contentHash,
    profiles: Object.fromEntries(
      pilot.manifest.profiles.map(({ id }) => {
        const planned = pilot.manifest.plan.trials.filter((t) => t.profileId === id);
        const criticalFailures = new Set();
        const hardFailures = new Map();
        for (const item of planned) {
          const spec = pilot.manifest.cases.find((c) => c.id === item.caseId);
          const trial = pilot.trials.find((t) => t.id === item.id);
          const grade = gradeTrial(spec, trial);
          if (spec.critical && !grade.passed) criticalFailures.add(spec.id);
          for (const failure of grade.failures)
            if (defaultPolicy.hardFailureCategories.includes(failure.category))
              hardFailures.set(`${spec.id}:${failure.category}`, {
                caseId: spec.id,
                category: failure.category,
              });
        }
        return [
          id,
          {
            criticalFailures: [...criticalFailures],
            hardFailures: [...hardFailures.values()],
            capabilityGaps: pilot.manifest.cases
              .filter((c) => c.capabilityGap)
              .map((c) => ({ caseId: c.id, limitation: c.capabilityGap })),
          },
        ];
      }),
    ),
  };
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

export function assertFrozenImplementation(current, previous) {
  const currentCode = current.code ?? current;
  const previousCode = previous.code ?? previous;
  for (const path of new Set([
    ...Object.keys(currentCode.files),
    ...Object.keys(previousCode.files),
  ]))
    if (currentCode.files[path] !== previousCode.files[path])
      throw new Error(`Implementation changed after pilot: ${path}`);
  if (current.browserBinarySha256 !== previous.browserBinarySha256)
    throw new Error("Implementation changed after pilot: Chromium binary");
  if (!isDeepStrictEqual(current.qualification?.artifact, previous.qualification?.artifact))
    throw new Error("Implementation changed after pilot: release artifact");
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
  const { summarizeQualification, policyForSuite } = await import("./qualification-policy.mjs");
  if (options.replay) {
    const run = await readRun(resolve(options.replay));
    const summary = summarizeQualification(run.manifest, run.trials, run.manifest.policy);
    printSummary(summary);
    return run.trials.length === run.manifest.plan.trials.length &&
      !run.trials.some((trial) => trial.accountingError)
      ? 0
      : 1;
  }
  if (
    options.mode === "live" &&
    !/^[a-f0-9]{64}$/.test(process.env.XPATHED_BROWSER_BINARY_SHA256 ?? "")
  )
    throw new Error("Live qualification requires the measured Chromium binary fingerprint");
  const selectedProfiles = options.profileIds.map((id) => profiles.find((p) => p.id === id));
  const code = await fingerprints();
  const artifact =
    process.env.XPATHED_RELEASE_ARTIFACT_JSON === undefined
      ? undefined
      : validateReleaseArtifact(
          JSON.parse(process.env.XPATHED_RELEASE_ARTIFACT_JSON),
          code.revision,
          options.profileIds,
        );
  const suite = await json(
    options.suite ||
      process.env.XPATHED_EVALUATION_SUITE ||
      new URL("./qualification-cases.json", import.meta.url),
  );
  const allCases = validateCases(suite);
  const defaultPolicy = policyForSuite(suite);
  const preparedAccounting =
    Boolean(suite.baseline) || defaultPolicy.latencyProtocol === "resolver-http-pre-reserved-v2";
  if (
    options.sentinels &&
    (defaultPolicy.version !== "3" ||
      !Array.isArray(suite.sentinels) ||
      !suite.sentinels.length ||
      new Set(suite.sentinels).size !== suite.sentinels.length ||
      suite.sentinels.some((id) => !allCases.some((c) => c.id === id)))
  )
    throw new Error("Current-view frozen sentinel membership is required");
  const { cases, exclusions } = selectQualificationCases(allCases, {
    ...options,
    requiredContractVersion: defaultPolicy.requiredContractVersion,
    sentinelIds: options.sentinels ? suite.sentinels : undefined,
  });
  if (options.sentinels && cases.length !== suite.sentinels.length)
    throw new Error("Sentinel selection is incomplete");
  if (
    suite.baseline &&
    (options.phase !== "pilot" ||
      options.repetitions !== 1 ||
      options.profileIds.length !== 1 ||
      options.profileIds[0] !== "deepseek" ||
      cases.length !== allCases.length ||
      options.caseId)
  )
    throw new Error(
      "Paired baseline requires the complete suite, one DeepSeek profile, one attempt and pilot phase",
    );
  if (options.forecastOnly && !suite.baseline)
    throw new Error("Forecast-only preparation requires the paired baseline suite");
  if (
    options.mode === "live" &&
    cases.some(
      (c) =>
        c.review.status !== "reviewed" ||
        !c.review.reviewer ||
        !Number.isFinite(Date.parse(c.review.reviewedAt)),
    )
  )
    throw new Error("Live qualification requires independently reviewed case labels");
  const output = resolve(options.output);
  await mkdir(join(output, "trials"), { recursive: true, mode: 0o700 });
  const pilot = options.pilot ? await readRun(resolve(options.pilot)) : null;
  if (pilot) {
    if (
      pilot.manifest.phase !== "pilot" ||
      pilot.manifest.mode !== options.mode ||
      pilot.manifest.cases.some((c) => c.split === "held-out")
    )
      throw new Error("Confirmation requires a matching development/regression pilot");
    if (pilot.trials.length !== pilot.manifest.plan.trials.length)
      throw new Error("Pilot has missing planned attempts");
    if (pilot.manifest.sourceManifestHash !== hash(suite))
      throw new Error("Case manifest changed after pilot");
    if (pilot.manifest.qualification?.policySha256 !== hash(defaultPolicy))
      throw new Error("Qualification policy changed after pilot");
    for (const profile of selectedProfiles)
      if (hash(pilot.manifest.profiles.find((p) => p.id === profile.id)) !== hash(profile))
        throw new Error(`Profile differs from pilot: ${profile.id}`);
  }
  const now = new Date().toISOString();
  const manifest = {
    version: "1",
    kind: "model-qualification",
    id: randomUUID(),
    createdAt: now,
    mode: options.mode,
    phase: options.phase,
    ...(options.sentinels ? { monitoring: true } : {}),
    cases,
    ...(suite.baseline ? { baseline: suite.baseline } : {}),
    exclusions,
    sourceManifestHash: hash(suite),
    profiles: selectedProfiles,
    baselineEvidence: pilot ? baselineEvidence(pilot) : null,
    plan: buildMatrixPlan(cases, selectedProfiles, options),
    code,
    browserBinarySha256: process.env.XPATHED_BROWSER_BINARY_SHA256 ?? null,
    policy: defaultPolicy,
    qualification: {
      ...(artifact === undefined ? {} : { artifact }),
      policySha256: hash(defaultPolicy),
      frozenAt: now,
      heldOutStartedAt: null,
      baselineRunIds: pilot ? [pilot.manifest.id] : [],
    },
    measurement: {
      latencyProtocol: preparedAccounting
        ? "resolver-http-pre-reserved-v2"
        : "resolver-http-inline-accounting-v1",
      latency:
        "Resolver HTTP end-to-end, including capture/model/verification; independent fixture setup and grading excluded" +
        (preparedAccounting
          ? "; durable budget reservation before execution, reconciliation after provider response and before next trial"
          : "; durable budget reservation and reconciliation inside request timing"),
      serving: "standard",
      responseReuse: false,
      healing: false,
      actionExecution: false,
      promptCache: "Provider warmth uncontrolled; cache usage retained",
      retentionDays: 90,
      evidenceDays: 30,
    },
  };
  if (pilot) assertFrozenImplementation(manifest, pilot.manifest);
  manifest.plan.trials = manifest.plan.trials.map((p) => ({
    ...p,
    id: randomUUID().replaceAll("-", ""),
  }));
  const services = {
    browser: process.env.XPATHED_BROWSER_URL ?? "http://browser:8080",
    fixture: process.env.XPATHED_FIXTURE_URL ?? "http://evaluation-fixture:8090",
  };
  const trials = [];
  let proxy, deterministicProxy, runError;
  const preparedRequests = new Map();
  async function runTrial(spec, planned, mode) {
    const profile = selectedProfiles.find((p) => p.id === planned.profileId);
    const trial = {
      ...planned,
      mode,
      createdAt: new Date().toISOString(),
      result: null,
      evidence: null,
    };
    if (mode === "live") {
      if (preparedAccounting)
        await proxy.reserveAttempt(
          trial.id,
          profile.id,
          manifest.preparedForecast.reservations.find((r) => r.id === planned.id).maximumUsd,
          { preparedRequest: preparedRequests.get(planned.id) },
        );
      else proxy.beginAttempt(trial.id, profile.id);
    }
    await execute(spec, trial, { ...options, mode }, { ...services, resolver: profile.resolver });
    trial.configuration = configurationRecord(trial);
    if (mode === "live") {
      await proxy.awaitIdle();
      if (preparedAccounting) {
        try {
          await proxy.finishAttempt();
        } catch (error) {
          trial.accountingError = error.message;
        }
      }
      const calls = proxy.records.filter((r) => r.attemptId === trial.id);
      trial.provider = calls.map(({ request, response, ...metadata }) => metadata);
      trial.evidence = { ...trial.evidence, provider: calls };
    }
    trial.grade = gradeTrial(spec, trial);
    await save(join(output, "trials", `${trial.id}.json`), trial);
    return trial;
  }
  try {
    deterministicProxy = fixtureProxy(services.fixture, options.timeoutMs);
    deterministicProxy.listen(8091, "0.0.0.0");
    await once(deterministicProxy, "listening");
    if (options.mode === "live") {
      const chosen = suite.baseline
        ? cases
        : compatibilityCases(allCases, preparedAccounting ? cases : []);
      const gates = [];
      for (const spec of chosen)
        for (const profile of selectedProfiles)
          gates.push(
            await runTrial(
              spec,
              {
                id: randomUUID().replaceAll("-", ""),
                caseId: spec.id,
                profileId: profile.id,
                repetition: 1,
                attempt: 1,
              },
              "deterministic",
            ),
          );
      await save(
        join(output, "compatibility.json"),
        gates.map(({ id, caseId, profileId, grade }) => ({ id, caseId, profileId, grade })),
      );
      if (gates.some((t) => !t.grade.passed))
        throw new Error("Deterministic compatibility failed; no paid calls made");
      if (defaultPolicy.version === "3" && options.phase === "confirmation") {
        assertPilotReady(pilot);
        const { reserveHoldout } = await import("./release-exposure.mjs");
        manifest.qualification.exposure = await reserveHoldout(
          manifest,
          process.env.XPATHED_BUDGET_GITHUB_REPOSITORY,
          process.env.GH_TOKEN,
        );
      }
      await new Promise((resolve) => deterministicProxy.close(resolve));
      deterministicProxy = null;
      const { createBudgetProxy } = await import("./comparison-budget.mjs");
      await mkdir(join(output, "provider"));
      proxy = await createBudgetProxy({
        profiles: selectedProfiles,
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
      manifest.pricing = Object.fromEntries(proxy.profiles.map((p) => [p.id, p.pricing]));
      manifest.routeMetadata = proxy.profiles;
      if (preparedAccounting) {
        manifest.preparedForecast = proxy.forecastRequests(
          manifest.plan.trials.map((planned) => {
            const prepared = gates.find(
              (gate) => gate.caseId === planned.caseId && gate.profileId === planned.profileId,
            );
            preparedRequests.set(planned.id, prepared?.evidence?.preparedProviderRequest);
            return {
              id: planned.id,
              profileId: planned.profileId,
              request: prepared?.evidence?.preparedProviderRequest,
            };
          }),
        );
        await save(join(output, "forecast.json"), manifest.preparedForecast);
        if (options.forecastOnly) {
          manifest.measurement.forecastOnly = true;
          manifest.contentHash = hash(manifest);
          await save(join(output, "manifest.json"), manifest);
          console.log(
            `Prepared ${manifest.preparedForecast.reservations.length} requests; estimated upper USD ${manifest.preparedForecast.projectedUsd ?? "unavailable"}; provider key limits apply; no paid calls made.`,
          );
          return 0;
        }
      }
      if (pilot) {
        manifest.forecast = forecastPilot(pilot, manifest.plan.trials, manifest.pricing);
      }
      proxy.server.listen(8091, "0.0.0.0");
      await once(proxy.server, "listening");
    }
    if (cases.some((c) => c.split === "held-out"))
      manifest.qualification.heldOutStartedAt = new Date().toISOString();
    manifest.contentHash = hash(manifest);
    await save(join(output, "manifest.json"), manifest);
    for (const planned of manifest.plan.trials) {
      const trial = await runTrial(
        cases.find((c) => c.id === planned.caseId),
        planned,
        options.mode,
      );
      trials.push(trial);
      console.log(
        `${trial.grade.passed ? "PASS" : "FAIL"} ${trial.profileId} ${trial.caseId} #${trial.repetition} ${Math.round(trial.elapsedMs ?? 0)}ms`,
      );
      if (trial.accountingError) throw new Error(trial.accountingError);
      if (
        options.mode === "live" &&
        trial.provider.some((p) => p.identityValid === false || p.responseCacheHit)
      )
        throw new Error(
          "Provider identity or response-cache gate failed; remaining planned attempts were not run",
        );
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
  const summary = summarizeQualification(manifest, trials, manifest.policy);
  await save(join(output, "summary.json"), summary);
  printSummary(summary);
  // A completed live measurement may truthfully find no qualifying model.
  return runError ||
    trials.length !== manifest.plan.trials.length ||
    (options.mode === "deterministic" && trials.some((t) => !t.grade.passed))
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
