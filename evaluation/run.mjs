import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rm, rename, lstat, readlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { loadCases } from "./cases/load.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const saveJson = async (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

export function parseOptions(args) {
  const options = {
    mode: "deterministic",
    repetitions: 1,
    concurrency: 1,
    seed: 1,
    timeoutMs: 45000,
    output: resolve(".artifacts/evaluation", randomUUID()),
  };
  const names = {
    "--mode": "mode",
    "--repetitions": "repetitions",
    "--seed": "seed",
    "--concurrency": "concurrency",
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
    throw new Error(
      "Mode must be deterministic (controlled provider-free) or live (live provider inference)",
    );
  for (const [name, min, max] of [
    ["repetitions", 1, 100],
    ["concurrency", 1, 4],
    ["seed", 0, 4294967295],
    ["timeoutMs", 1000, 300000],
  ]) {
    options[name] = Number(options[name]);
    if (!Number.isInteger(options[name]) || options[name] < min || options[name] > max)
      throw new Error(`Invalid ${name}`);
  }
  if (options.mode === "live" && options.concurrency !== 1)
    throw new Error("Live evaluation requires concurrency 1");
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
    if (
      !item.family ||
      ![
        "development",
        "regression",
        "held-out",
        ...(item.dataset
          ? ["train", "dev", "test", "test_task", "test_website", "test_domain"]
          : []),
      ].includes(item.split)
    )
      throw new Error("Invalid family or split");
    if (families.has(item.family) && families.get(item.family) !== item.split)
      throw new Error("A family cannot cross split boundaries");
    families.set(item.family, item.split);
    if (!Array.isArray(item.expected?.actions)) throw new Error("Expected actions are required");
    if (!item.instruction || !item.fixture || !item.review || !item.category)
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
    concurrency: options.concurrency ?? 1,
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
      commit: manifest.code.revision,
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
    promptHash: evidence?.systemPrompt ? hash(evidence.systemPrompt) : null,
    schemaHash: evidence?.outputSchema ? hash(evidence.outputSchema) : null,
    effective: effective
      ? {
          ...pick(effective, [
            "strategy",
            "scope",
            "serverDeadlineMs",
            "estimateCost",
            "pricingCacheSeconds",
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
            "prompt_cache_options",
          ]),
        }
      : null,
  };
}

export async function retainConfigurations(output, manifest, trial) {
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

export async function request(url, body, timeoutMs = 45000, headers = {}) {
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

export async function command(fixture, trialId, body, timeoutMs) {
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
  if (options.track === "xpath") {
    const { resolveXPathTrial } = await import("./xpath.mjs");
    return resolveXPathTrial(spec, trial, session, page, options, services, channelId);
  }
  const started = performance.now();
  try {
    const envelope = await request(
      `${services.resolver}/internal/pages/${session.pageId}/resolve`,
      {
        instruction: spec.instruction,
        documentId: page.documentId,
      },
      options.timeoutMs,
      {
        "X-Xpathed-Attempt-Id": trial.id,
        ...(options.concurrency > 1
          ? {
              traceparent: `00-${hash(channelId).slice(0, 32)}-${randomUUID().replaceAll("-", "").slice(0, 16)}-01`,
            }
          : {}),
      },
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
        trial.evidence = { ...trial.evidence, preparedProviderRequest: providerRequest };
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

export async function execute(spec, trial, options, services) {
  let session;
  try {
    await request(
      `${services.fixture}/trial`,
      {
        id: trial.id,
        caseId: spec.id,
        ...(options.concurrency > 1 ? { traceId: hash(trial.id).slice(0, 32) } : {}),
      },
      options.timeoutMs,
    );
    session = await request(
      `${services.browser}/sessions`,
      { browserType: "chromium" },
      options.timeoutMs,
    );
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
        {
          documentId: page.documentId,
          scope: "current_view",
        },
        options.timeoutMs,
      );
      if (capture.scope !== "current_view")
        throw new Error("Current-view capture returned the wrong scope");
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
      trial.captureObservation.captureBytes = Buffer.byteLength(capturedText);
      trial.captureObservation.scope = capture.scope ?? "page";
      trial.captureObservation.privacyLeak = (spec.privacySentinels ?? []).some((s) =>
        capturedText.includes(s),
      );
    } catch (error) {
      trial.captureObservation = {
        error: { code: error.code ?? error.name, message: error.message },
      };
    }
    await resolveTrial(spec, trial, session, page, options, services);
    if (trial.captureObservation?.error)
      trial.error ??= {
        code: "capture_scope_unverified",
        message: "Independent current-view capture could not be verified",
      };
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

export async function fingerprints(
  root = process.env.XPATHED_WORKSPACE ?? resolve(directory, ".."),
) {
  const paths = [
    "global.json",
    "pnpm-lock.yaml",
    "package.json",
    "Directory.Build.props",
    "Directory.Build.targets",
    "Directory.Packages.props",
    "NuGet.Config",
    ".editorconfig",
    ".dockerignore",
    "docker/compose.yaml",
    "docker/compose.evaluation.yaml",
    "docker/compose.qualification.yaml",
    "docker/compose.sh",
    "scripts/evaluate.sh",
    "scripts/evaluate-all.mjs",
    "tests/resolution/ready.mjs",
  ];
  async function collect(path) {
    const entries = await readdir(join(root, path), { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (["bin", "obj", "node_modules", ".git"].includes(entry.name)) continue;
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await collect(child);
      else if (!/\.md$|\.test\.mjs$/.test(entry.name)) paths.push(child);
    }
  }
  for (const path of [
    "src/Browser",
    "src/Resolver",
    "src/Common",
    "docker/browser",
    "docker/resolver",
    "evaluation",
  ])
    await collect(path);
  const files = {};
  for (const path of [...new Set(paths)].sort()) {
    try {
      files[path] = hash(await readFile(join(root, path)));
    } catch {
      files[path] = "unavailable";
    }
  }
  for (const path of [
    "src/Resolver/bin/Release/net10.0/Resolver.dll",
    "src/Resolver/bin/Release/net10.0/Common.dll",
  ]) {
    try {
      files[path] = hash(await readFile(join(root, path)));
    } catch {
      files[path] = "unavailable";
    }
  }
  let revision = process.env.XPATHED_CODE_REVISION,
    tree = process.env.XPATHED_TREE_HASH;
  try {
    revision ??= execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!tree) {
      const paths = execFileSync(
        "git",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      )
        .split("\0")
        .filter(Boolean)
        .sort();
      const digest = createHash("sha256");
      for (const path of new Set(paths)) {
        digest.update(path + "\0");
        try {
          const full = join(root, path);
          digest.update(
            (await lstat(full)).isSymbolicLink() ? await readlink(full) : await readFile(full),
          );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          digest.update("[deleted]");
        }
        digest.update("\0");
      }
      tree = digest.digest("hex");
    }
  } catch {}
  return {
    revision: revision ?? "unavailable",
    tree: tree ?? "unavailable",
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
  const context = manifest.kind === "context-experiment" && manifest.version === 1;
  if (
    (!context && manifest.version !== "1") ||
    !manifest.id ||
    !Array.isArray(context ? manifest.plan : manifest.plan?.trials) ||
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
  if (context) delete manifest.preparedRequests;
  for (const spec of manifest.cases ?? []) delete spec.input;
  manifest.evidenceAvailability = "expired";
  // Keep the frozen hash: removed raw evidence intentionally cannot pass replay integrity.
  await writeFile(join(path, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const sub of ["trials", "imports", ...(context ? ["preflight"] : [])])
    for (const file of await readdir(join(path, sub)).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      if (file.endsWith(".json.partial")) {
        await rm(join(path, sub, file));
        continue;
      }
      if (!file.endsWith(".json")) continue;
      const name = join(path, sub, file),
        value = await readJson(name);
      value.evidence = null;
      value.evidenceAvailability = "expired";
      if (value.baseline) {
        value.baseline.evidence = null;
        value.baseline.evidenceAvailability = "expired";
      }
      if (value.mutation?.fresh) value.mutation.fresh.evidence = null;
      await writeFile(name, JSON.stringify(value, null, 2) + "\n");
    }
  // Comparison provider snapshots contain the same expiring input/output evidence.
  await rm(join(path, "provider"), { recursive: true, force: true });
  await rm(join(path, "offline"), { recursive: true, force: true });
  return "evidence_deleted";
}

export async function runTrials(plan, executeTrial) {
  const pending = plan.trials.entries();
  const trials = [];
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(plan.concurrency, plan.trials.length) }, async () => {
      for (const [index, trial] of pending) trials[index] = await executeTrial(trial);
    }),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Evaluation worker failed",
    );
  return trials;
}

export async function main(args = process.argv.slice(2), track = "resolver") {
  const options = parseOptions(args);
  options.track = track;
  if (track === "xpath" && options.mode !== "deterministic")
    throw new Error(
      "XPath construction and verification uses controlled provider-free selections and no model calls",
    );
  if (!args.includes("--concurrency") && options.mode === "deterministic")
    options.concurrency = Math.min(4, availableParallelism());
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
  const suite = loadCases(
    process.env.XPATHED_EVALUATION_SUITE || join(directory, "cases/index.json"),
  );
  if (process.env.XPATHED_EVALUATION_SUITE && options.mode !== "deterministic")
    throw new Error("Custom suites use controlled provider-free browser validation");
  let cases = validateCases(suite);
  let exclusions = [];
  if (track === "xpath") {
    const { selectXPathCases } = await import("./xpath.mjs");
    ({ cases, exclusions } = selectXPathCases(cases));
  }
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
    track,
    exclusions,
    configurations: {},
    cases: cases.map((item) =>
      item.fixture?.kind === "derived-static-dom" && item.fixture.sha256
        ? { ...item, fixture: { kind: item.fixture.kind, sha256: item.fixture.sha256 } }
        : item,
    ),
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
  let configurations = Promise.resolve();
  const trials = await runTrials(plan, async (planned) => {
    const spec = cases.find((c) => c.id === planned.caseId);
    const trial = { ...planned, createdAt: new Date().toISOString(), result: null, evidence: null };
    await execute(spec, trial, options, services);
    const grade = gradeTrial(spec, trial);
    await saveJson(join(options.output, "trials", `${trial.id}.json`), trial);
    if (track !== "xpath")
      await saveJson(
        join(options.output, "imports", `${trial.id}.json`),
        toArtifact(manifest, trial, grade),
      );
    // Only manifest writes share a path; trial and import files have unique identities.
    configurations = configurations.then(() =>
      retainConfigurations(options.output, manifest, trial),
    );
    await configurations;
    console.log(
      `${grade.passed ? "PASS" : "FAIL"} ${trial.caseId} #${trial.repetition}: ${grade.failures.map((f) => f.category).join(", ") || "declared checks passed"}`,
    );
    return trial;
  });
  const summary = summarize(manifest, trials);
  await saveJson(join(options.output, "summary.json"), summary);
  const first = summary.firstAttempt;
  const readable =
    [
      `Evaluation: ${track === "xpath" ? "XPath construction and verification" : "Live-browser Resolver"}; inference mode: ${options.mode === "deterministic" ? "controlled provider-free" : "live provider inference"}; qualification: ${summary.qualification}`,
      `Trials: ${summary.completedTrials}/${summary.plannedTrials}; checks passed: ${first.passed}; failed: ${first.failed}`,
      `Intended targets: ${first.metrics.targetsCorrect}/${first.metrics.targetsExpected}; wrong targets: ${first.metrics.wrongTargets}`,
      `Saved XPath mutations: ${first.savedLocator.passed}/${first.savedLocator.trials}; fresh resolutions: ${first.freshResolution?.passed ?? 0}/${first.freshResolution?.trials ?? 0}`,
      `Resolution latency p50/p95: ${first.latencyMs.p50 ?? "unavailable"}/${first.latencyMs.p95 ?? "unavailable"} ms`,
      `Reported cost: ${first.cost.reportedUsd.total ?? "unavailable"} USD; estimated: ${first.cost.estimatedUsd.total ?? "unavailable"} USD (fresh mutation calls reported separately)`,
      ...summary.failures.map((f) => `${f.caseId}: ${f.category} — ${f.detail}`),
      track === "xpath"
        ? "Controlled selections isolate XPath verification; no model call was made. See summary.json for coverage."
        : "Deterministic provider scores do not measure model quality. See summary.json for coverage and unavailable metrics.",
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
