import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rm, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const directory = fileURLToPath(new URL(".", import.meta.url));
const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const saveJson = async (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

export function parseOptions(args) {
  const options = {
    mode: "deterministic",
    repetitions: 1,
    seed: 1,
    timeoutMs: 45000,
    output: resolve(".artifacts/evaluation", randomUUID()),
  };
  const names = {
    "--mode": "mode",
    "--repetitions": "repetitions",
    "--seed": "seed",
    "--timeout-ms": "timeoutMs",
    "--case": "caseId",
    "--output": "output",
    "--replay": "replay",
    "--prune": "prune",
  };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]];
    if (!name || seen.has(name) || !args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error("Unknown, repeated or missing evaluation option");
    seen.add(name);
    options[name] = args[i + 1];
  }
  if (!["deterministic", "live"].includes(options.mode))
    throw new Error("Mode must be deterministic or live");
  for (const [name, min, max] of [
    ["repetitions", 1, 100],
    ["seed", 0, 4294967295],
    ["timeoutMs", 1000, 300000],
  ]) {
    options[name] = Number(options[name]);
    if (!Number.isInteger(options[name]) || options[name] < min || options[name] > max)
      throw new Error(`Invalid ${name}`);
  }
  if ((options.replay || options.prune) && seen.size !== 1)
    throw new Error("Replay/prune cannot be combined with run options");
  return options;
}

export function validateCases(manifest) {
  if (manifest.version !== "1" || !Array.isArray(manifest.cases) || !manifest.cases.length)
    throw new Error("Unsupported or empty case manifest");
  const ids = new Set(),
    families = new Map();
  for (const item of manifest.cases) {
    if (!/^[a-z0-9_-]+$/.test(item.id) || ids.has(item.id))
      throw new Error("Invalid or duplicate case id");
    ids.add(item.id);
    if (!item.family || !["development", "regression", "held-out"].includes(item.split))
      throw new Error("Invalid family or split");
    if (families.has(item.family) && families.get(item.family) !== item.split)
      throw new Error("A family cannot cross split boundaries");
    families.set(item.family, item.split);
    if (!Array.isArray(item.expected?.actions)) throw new Error("Expected actions are required");
    if (!item.instruction || !item.fixture || !item.setupRevision || !item.review || !item.category)
      throw new Error("Case provenance is incomplete");
    if (item.viewport?.width !== 1280 || item.viewport?.height !== 800)
      throw new Error("Only the managed 1280x800 viewport is currently supported");
    for (const action of item.expected.actions) {
      if (
        !Number.isInteger(action.step) ||
        action.step < 1 ||
        !action.action ||
        !["found", "not_found", "unsupported", "error"].includes(action.outcome)
      )
        throw new Error("Invalid expected action");
      if (action.outcome === "found" && !action.target?.selector)
        throw new Error("Found actions require an independent target mapping");
    }
  }
  return manifest.cases;
}

export function buildPlan(cases, options) {
  const caseOrder = cases.map((c) => c.id);
  let seed = options.seed >>> 0;
  for (let i = caseOrder.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [caseOrder[i], caseOrder[j]] = [caseOrder[j], caseOrder[i]];
  }
  return {
    seed: options.seed,
    repetitions: options.repetitions,
    timeoutMs: options.timeoutMs,
    concurrency: 1,
    retries: 0,
    caseOrder,
    trials: Array.from({ length: options.repetitions }, (_, i) =>
      caseOrder.map((caseId) => ({ caseId, repetition: i + 1, attempt: 1 })),
    ).flat(),
  };
}

export function toArtifact(manifest, trial, grade) {
  const { evidence, ...record } = trial;
  // Mutation evidence has the same short lifetime as the first model input.
  const freshEvidence = record.mutation?.fresh?.evidence;
  if (record.mutation)
    record.mutation = {
      ...record.mutation,
      fresh: { ...record.mutation.fresh, evidence: undefined },
    };
  return {
    version: "1",
    id: trial.id,
    kind: "evaluation",
    traceId: trial.result?.traceId ?? trial.id,
    pageId: trial.result?.pageId ?? "unavailable",
    outcome: grade.passed ? "passed" : "failed",
    createdAt: trial.createdAt,
    expiresAt: new Date(Date.parse(trial.createdAt) + 90 * 86400000).toISOString(),
    evidenceExpiresAt: new Date(Date.parse(trial.createdAt) + 30 * 86400000).toISOString(),
    evidenceAvailability: evidence?.availability ?? "unavailable",
    result: { ...record, grade },
    evidence: evidence
      ? { ...evidence, ...(freshEvidence ? { freshResolution: freshEvidence } : {}) }
      : null,
    provenance: {
      source: "evaluation",
      schemaVersion: "1",
      codeVersion: manifest.code.revision,
      configurationId: trial.result?.configurationId ?? "unavailable",
      caseId: trial.caseId,
      runId: manifest.id,
    },
  };
}

export function configurationRecord(trial) {
  const evidence = trial.evidence;
  const configuration = evidence?.configurationJson ? JSON.parse(evidence.configurationJson) : {};
  const effective = configuration.effective;
  const pick = (value, keys) =>
    Object.fromEntries(
      keys.filter((key) => Object.hasOwn(value ?? {}, key)).map((key) => [key, value[key]]),
    );
  return {
    configurationId: trial.result?.configurationId ?? "unavailable",
    model: configuration.Model ?? trial.result?.diagnostics?.model ?? null,
    provider: configuration.Provider ?? trial.result?.diagnostics?.provider ?? null,
    strategy: configuration.Strategy ?? trial.result?.diagnostics?.strategy ?? null,
    promptVersion: configuration.PromptVersion ?? trial.result?.diagnostics?.promptVersion ?? null,
    promptHash: evidence?.systemPrompt ? hash(evidence.systemPrompt) : null,
    schemaHash: evidence?.outputSchema ? hash(evidence.outputSchema) : null,
    effective: effective
      ? {
          ...pick(effective, [
            "strategy",
            "promptVersion",
            "captureVersion",
            "stateVersion",
            "interactabilityVersion",
            "xpathVersion",
            "endpoint",
            "timeoutSeconds",
            "modelInputBudgetBytes",
            "responseCache",
            "maximumActions",
          ]),
          request: pick(effective.request, [
            "model",
            "stream",
            "max_tokens",
            "reasoning",
            "provider",
            "plugins",
          ]),
        }
      : null,
  };
}

async function retainConfigurations(output, manifest, trial) {
  for (const attempt of [trial, trial.mutation?.fresh].filter(Boolean)) {
    const record = configurationRecord(attempt);
    if (
      record.configurationId !== "unavailable" &&
      (!manifest.configurations[record.configurationId]?.effective || record.effective)
    )
      manifest.configurations[record.configurationId] = record;
  }
  delete manifest.contentHash;
  manifest.contentHash = hash(manifest);
  const temporary = join(output, "manifest.pending.json");
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n");
  await rename(temporary, join(output, "manifest.json"));
}

async function request(url, body, timeoutMs = 45000, headers = {}) {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.code = `http_${response.status}`;
    throw error;
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error("Service returned malformed JSON");
    error.code = "invalid_service_json";
    throw error;
  }
}

async function command(fixture, trialId, body, timeoutMs) {
  const id = randomUUID();
  await request(`${fixture}/command?trial=${trialId}`, { ...body, id }, timeoutMs);
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const value = await request(`${fixture}/observation?trial=${trialId}`, undefined, timeoutMs);
    if (value?.id === id) {
      if (value.error) throw new Error(`Fixture observation failed: ${value.error}`);
      return value;
    }
    await delay(50);
  }
  throw new Error("Fixture observation timeout");
}

async function mapCandidates(candidates, identity, browser, timeoutMs) {
  const coverageTargets = [];
  // Map captured IDs through the Browser contract, then independently compare actual DOM nodes.
  // Never use the generated XPath itself as the expected target label.
  for (let i = 0; i < candidates.length; i += 16) {
    const selection = await request(
      `${browser}/pages/${identity.pageId}/selections`,
      {
        documentId: identity.documentId,
        captureId: identity.captureId,
        actions: candidates.slice(i, i + 16).map((candidate, index) => ({
          actionId: `coverage${index}`,
          candidateId: candidate.id,
          action: "inspect",
        })),
      },
      timeoutMs,
    );
    coverageTargets.push(...selection.actions.map((item) => item.target).filter(Boolean));
  }
  return coverageTargets;
}

async function observe(spec, trial, session, fixture, browser, timeoutMs) {
  const input = trial.evidence?.modelInput ? JSON.parse(trial.evidence.modelInput) : null;
  const candidates = input?.candidates ?? [];
  const coverageTargets = await mapCandidates(candidates, trial.result, browser, timeoutMs);
  const observation = await command(
    fixture,
    trial.id,
    {
      kind: "observe",
      expected: spec.expected.actions.map((a) => a.target ?? null),
      actions: trial.result?.actions ?? [],
      coverageTargets,
      modelInputIds: candidates.map((c) => c.id),
    },
    timeoutMs,
  );
  observation.captureCoverage = trial.captureObservation?.captureCoverage ?? null;
  if (!input) observation.modelInputCoverage = null;
  const modelText = JSON.stringify({ result: trial.result, evidence: trial.evidence });
  observation.oracleLeak = (spec.oracleSentinels ?? []).some((s) => modelText.includes(s));
  observation.privacyLeak = (spec.privacySentinels ?? []).some((s) => modelText.includes(s));
  const tolerance = spec.viewport.tolerance ?? 0;
  if (
    Math.abs(observation.viewport.width - spec.viewport.width) > tolerance ||
    Math.abs(observation.viewport.height - spec.viewport.height) > tolerance
  )
    throw new Error("Fixture viewport does not match the manifest");
  return observation;
}

async function resolveTrial(spec, trial, session, page, options, services, channelId = trial.id) {
  const started = performance.now();
  try {
    const envelope = await request(
      `${services.resolver}/internal/pages/${session.pageId}/resolve`,
      { instruction: spec.instruction, documentId: page.documentId, contractVersion: "2" },
      options.timeoutMs,
      { "X-Xpathed-Attempt-Id": trial.id },
    );
    trial.result = envelope.result;
    trial.evidence = envelope.evidence;
    trial.elapsedMs = performance.now() - started;
    if (
      trial.result?.pageId !== session.pageId ||
      trial.result?.documentId !== page.documentId ||
      trial.result?.attemptId !== trial.id
    )
      throw new Error("Resolution identity mismatch");
    trial.observation = await observe(
      spec,
      { ...trial, id: channelId },
      session,
      services.fixture,
      services.browser,
      options.timeoutMs,
    );
  } catch (error) {
    trial.elapsedMs ??= performance.now() - started;
    trial.error = { code: error.code ?? error.name, message: error.message };
  } finally {
    trial.observation ??= {};
    trial.observation.privacyLeak ||= trial.captureObservation?.privacyLeak === true;
    if (options.mode === "deterministic") {
      try {
        const providerRequest = await request(
          `${services.fixture}/provider-request?trial=${channelId}`,
          undefined,
          options.timeoutMs,
        );
        const text = JSON.stringify(providerRequest);
        trial.observation.privacyLeak ||= (spec.privacySentinels ?? []).some((s) =>
          text.includes(s),
        );
        trial.observation.oracleLeak ||= (spec.oracleSentinels ?? []).some((s) => text.includes(s));
      } catch (error) {
        trial.error ??= { code: "provider_observation_failed", message: error.message };
      }
    }
  }
}

async function execute(spec, trial, options, services) {
  let session;
  try {
    await request(
      `${services.fixture}/trial`,
      { id: trial.id, caseId: spec.id },
      options.timeoutMs,
    );
    session = await request(`${services.browser}/sessions`, {}, options.timeoutMs);
    const page = await request(
      `${services.browser}/pages/${session.pageId}/navigate`,
      { url: `${services.fixture}/fixture?trial=${trial.id}` },
      options.timeoutMs,
    );
    trial.environment = await command(
      services.fixture,
      trial.id,
      { kind: "baseline", setup: spec.setup ?? {} },
      options.timeoutMs,
    );
    try {
      const capture = await request(
        `${services.browser}/pages/${session.pageId}/capture`,
        { documentId: page.documentId },
        options.timeoutMs,
      );
      const coverageTargets = await mapCandidates(
        capture.candidates,
        capture,
        services.browser,
        options.timeoutMs,
      );
      trial.captureObservation = await command(
        services.fixture,
        trial.id,
        {
          kind: "observe",
          expected: spec.expected.actions.map((a) => a.target ?? null),
          actions: [],
          coverageTargets,
        },
        options.timeoutMs,
      );
      const capturedText = JSON.stringify(capture);
      trial.captureObservation.privacyLeak = (spec.privacySentinels ?? []).some((s) =>
        capturedText.includes(s),
      );
    } catch (error) {
      trial.captureObservation = {
        error: { code: error.code ?? error.name, message: error.message },
      };
    }
    await resolveTrial(spec, trial, session, page, options, services);
    if (spec.mutation && trial.result?.actions?.some((a) => a.target)) {
      const changed = await command(
        services.fixture,
        trial.id,
        {
          kind: "mutate",
          mutation: spec.mutation,
          actions: trial.result.actions,
          expected: spec.mutation.afterExpected.actions.map((a) => a.target ?? null),
        },
        options.timeoutMs,
      );
      const fresh = {
        id: randomUUID().replaceAll("-", ""),
        caseId: spec.id,
        createdAt: new Date().toISOString(),
        attempt: 1,
        repetition: trial.repetition,
      };
      trial.mutation = {
        expected: ["remove", "replacement"].includes(spec.mutation.kind) ? "removed" : "preserved",
        matches: changed.actions.flatMap((a) => a.matches),
        fresh,
      };
      // The fixture command channel remains owned by the original page's trial.
      const freshSpec = { ...spec, expected: spec.mutation.afterExpected };
      await resolveTrial(freshSpec, fresh, session, page, options, services, trial.id);
    }
  } catch (error) {
    trial.error = { code: error.code ?? error.name, message: error.message };
  } finally {
    if (session) {
      try {
        const response = await fetch(`${services.browser}/sessions/${session.sessionId}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error("Session cleanup failed");
      } catch (error) {
        trial.cleanupError = error.message;
        trial.error ??= { code: "cleanup_failed", message: error.message };
      }
    }
  }
}

async function fingerprints() {
  const root = process.env.XPATHED_WORKSPACE ?? resolve(directory, "..");
  const paths = [
    "global.json",
    "pnpm-lock.yaml",
    "src/Browser/packages.lock.json",
    "src/Resolver/packages.lock.json",
    "src/Browser/Sessions/BrowserCaptureScript.cs",
    "src/Resolver/Services/CandidateSelectionStrategy.cs",
    "src/Resolver/Services/ActionSelectionStrategy.cs",
    "src/Resolver/Services/OpenRouterGateway.cs",
    "docker/browser/Dockerfile",
    "docker/compose.yaml",
  ];
  const files = {};
  for (const path of paths) {
    try {
      files[path] = hash(await readFile(join(root, path), "utf8"));
    } catch {
      files[path] = "unavailable";
    }
  }
  for (const name of await readdir(directory))
    if (/\.(mjs|js|json)$/.test(name))
      files[`evaluation/${name}`] = hash(await readFile(join(directory, name), "utf8"));
  return {
    revision: process.env.XPATHED_CODE_REVISION ?? "unavailable",
    tree: process.env.XPATHED_TREE_HASH ?? "unavailable",
    node: process.version,
    files,
  };
}

export async function replay(path) {
  const { summarize } = await import("./grader.mjs");
  const manifest = await readJson(join(path, "manifest.json"));
  const recordedHash = manifest.contentHash;
  delete manifest.contentHash;
  if (hash(manifest) !== recordedHash) throw new Error("Manifest integrity mismatch");
  validateCases({ version: manifest.version, cases: manifest.cases });
  if (
    manifest.code.files["evaluation/grader.mjs"] !==
    hash(await readFile(join(directory, "grader.mjs"), "utf8"))
  )
    throw new Error("Grader revision differs; use the recorded revision to reproduce this report");
  const trials = [];
  for (const item of manifest.plan.trials) {
    try {
      trials.push(await readJson(join(path, "trials", `${item.id}.json`)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // The grader accounts for every missing planned trial; do not invent a completed attempt.
    }
  }
  return summarize(manifest, trials);
}

export async function prune(path, now = new Date()) {
  const manifest = await readJson(join(path, "manifest.json"));
  if (
    manifest.version !== "1" ||
    !manifest.id ||
    !Array.isArray(manifest.plan?.trials) ||
    !manifest.code ||
    !Number.isFinite(Date.parse(manifest.createdAt))
  )
    throw new Error("Not an evaluation artifact directory");
  const age = now.getTime() - Date.parse(manifest.createdAt);
  if (age >= 90 * 86400000) {
    await rm(path, { recursive: true });
    return "records_deleted";
  }
  if (age < 30 * 86400000) return "retained";
  for (const sub of ["trials", "imports"])
    for (const file of await readdir(join(path, sub))) {
      if (!file.endsWith(".json")) continue;
      const name = join(path, sub, file),
        value = await readJson(name);
      value.evidence = null;
      value.evidenceAvailability = "expired";
      if (value.mutation?.fresh) value.mutation.fresh.evidence = null;
      await writeFile(name, JSON.stringify(value, null, 2) + "\n");
    }
  return "evidence_deleted";
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.prune) {
    console.log(await prune(resolve(options.prune)));
    return 0;
  }
  if (options.replay) {
    const summary = await replay(resolve(options.replay));
    console.log(JSON.stringify(summary, null, 2));
    return summary.passed ? 0 : 1;
  }
  const { gradeTrial, summarize } = await import("./grader.mjs");
  const suite = await readJson(join(directory, "cases.json"));
  let cases = validateCases(suite);
  if (options.caseId) cases = cases.filter((c) => c.id === options.caseId);
  if (options.mode === "live")
    cases = cases.filter((c) => !c.provider?.fault && !c.deterministicOnly);
  if (!cases.length) throw new Error("No matching cases");
  const plan = buildPlan(cases, options);
  plan.trials = plan.trials.map((t) => ({ ...t, id: randomUUID().replaceAll("-", "") }));
  const manifest = {
    version: "1",
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    mode: options.mode,
    configurations: {},
    cases,
    plan,
    code: await fingerprints(),
    policy: {
      qualification: "incomplete",
      qualityThresholds: null,
      retentionDays: 90,
      evidenceDays: 30,
    },
    sourceManifestHash: hash(suite),
  };
  manifest.contentHash = hash(manifest);
  await mkdir(join(options.output, "trials"), { recursive: true });
  await mkdir(join(options.output, "imports"), { recursive: true });
  await saveJson(join(options.output, "manifest.json"), manifest);
  const services = {
    browser: process.env.XPATHED_BROWSER_URL ?? "http://browser:8080",
    resolver: process.env.XPATHED_RESOLVER_URL ?? "http://resolver:8080",
    fixture: process.env.XPATHED_FIXTURE_URL ?? "http://evaluation-fixture:8090",
  };
  const trials = [];
  for (const planned of plan.trials) {
    const spec = cases.find((c) => c.id === planned.caseId);
    const trial = { ...planned, createdAt: new Date().toISOString(), result: null, evidence: null };
    await execute(spec, trial, options, services);
    const grade = gradeTrial(spec, trial);
    await saveJson(join(options.output, "trials", `${trial.id}.json`), trial);
    await saveJson(
      join(options.output, "imports", `${trial.id}.json`),
      toArtifact(manifest, trial, grade),
    );
    await retainConfigurations(options.output, manifest, trial);
    trials.push(trial);
    console.log(
      `${grade.passed ? "PASS" : "FAIL"} ${trial.caseId} #${trial.repetition}: ${grade.failures.map((f) => f.category).join(", ") || "declared checks passed"}`,
    );
  }
  const summary = summarize(manifest, trials);
  await saveJson(join(options.output, "summary.json"), summary);
  const first = summary.firstAttempt;
  const readable =
    [
      `Mode: ${options.mode}; qualification: ${summary.qualification}`,
      `Trials: ${summary.completedTrials}/${summary.plannedTrials}; checks passed: ${first.passed}; failed: ${first.failed}`,
      `Intended targets: ${first.metrics.targetsCorrect}/${first.metrics.targetsExpected}; wrong targets: ${first.metrics.wrongTargets}`,
      `Saved XPath mutations: ${first.savedLocator.passed}/${first.savedLocator.trials}; fresh resolutions: ${first.freshResolution?.passed ?? 0}/${first.freshResolution?.trials ?? 0}`,
      `Resolution latency p50/p95: ${first.latencyMs.p50 ?? "unavailable"}/${first.latencyMs.p95 ?? "unavailable"} ms`,
      `Reported cost: ${first.cost.reportedUsd.total ?? "unavailable"} USD; estimated: ${first.cost.estimatedUsd.total ?? "unavailable"} USD (fresh mutation calls reported separately)`,
      ...summary.failures.map((f) => `${f.caseId}: ${f.category} — ${f.detail}`),
      "Deterministic provider scores do not measure model quality. See summary.json for coverage and unavailable metrics.",
    ].join("\n") + "\n";
  await writeFile(join(options.output, "summary.txt"), readable, { flag: "wx" });
  console.log(readable);
  return summary.passed ? 0 : 1;
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
