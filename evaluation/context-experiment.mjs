import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { execute, validateCases, fingerprints, configurationRecord } from "./run.mjs";
import { gradeTrial } from "./grader.mjs";
import { datasetProfiles } from "./dataset-run.mjs";

const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const profile = datasetProfiles.find((p) => p.id === "deepseek-deepinfra");

export function buildContextPlan(cases) {
  const ids = new Set();
  return cases.flatMap((spec, index) => {
    if (spec.contractVersion !== "4")
      throw new Error("Context comparison requires current-view cases");
    if (ids.has(spec.id)) throw new Error("Duplicate context case");
    ids.add(spec.id);
    return (index % 2 ? ["jev", "control"] : ["control", "jev"]).map((arm) => ({
      id: randomUUID().replaceAll("-", ""),
      caseId: spec.id,
      arm,
      repetition: 1,
      attempt: 1,
    }));
  });
}

export function buildContextPreflightPlan(plan) {
  return plan.map((trial) => ({
    ...trial,
    id: randomUUID().replaceAll("-", ""),
    liveAttemptId: trial.id,
  }));
}

function quantile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
}

export function summarizeContext(plan, trials) {
  if (new Set(trials.map((t) => t.id)).size !== trials.length)
    throw new Error("Duplicate context attempt");
  for (const trial of trials) {
    if (!plan.some((p) => p.id === trial.id && p.arm === trial.arm && p.caseId === trial.caseId))
      throw new Error("Unplanned context attempt");
  }
  const generations = new Set(),
    freshnessErrors = [];
  let unverifiedCalls = 0;
  for (const trial of trials)
    for (const call of trial.provider ?? []) {
      if (!call.forwarded) continue;
      const generationId = call.observedIdentity?.generationId;
      if (typeof generationId !== "string" || !generationId.trim()) {
        unverifiedCalls++;
        if (call.identityValid === true)
          freshnessErrors.push(`Missing generation identity: ${trial.id}`);
      } else if (generations.has(generationId))
        freshnessErrors.push(`Repeated generation identity: ${trial.id}`);
      else generations.add(generationId);
    }
  const freshness = {
    valid: freshnessErrors.length === 0 && unverifiedCalls === 0,
    unverifiedCalls,
    errors: freshnessErrors,
  };
  const distribution = (values) => {
    const known = values.filter(Number.isFinite);
    return {
      observed: known.length,
      unavailable: values.length - known.length,
      total: known.length ? known.reduce((a, b) => a + b, 0) : null,
      p50: quantile(known, 0.5),
      p95: quantile(known, 0.95),
    };
  };
  const completeInputBytes = (t) =>
    t?.result?.diagnostics?.modelInputComplete === true
      ? t.result.diagnostics.modelInputBytes
      : null;
  const arms = Object.fromEntries(
    ["control", "jev"].map((arm) => {
      const planned = plan.filter((t) => t.arm === arm),
        completed = trials.filter((t) => t.arm === arm);
      const calls = completed.flatMap((t) => t.provider ?? []).filter((p) => p.forwarded);
      const known = calls.filter((p) => Number.isFinite(p.reportedUsd) && p.reportedUsd >= 0);
      const correct = completed.filter((t) => t.grade?.passed);
      const knownReportedUsd = known.reduce((sum, p) => sum + p.reportedUsd, 0);
      const stages = [
        ...new Set(completed.flatMap((t) => Object.keys(t.result?.diagnostics?.timingsMs ?? {}))),
      ];
      return [
        arm,
        {
          planned: planned.length,
          completed: completed.length,
          missing: planned.length - completed.length,
          correct: correct.length,
          correctWithinOneSecond: correct.filter((t) => t.elapsedMs < 1000).length,
          correctWithinTwoSeconds: correct.filter((t) => t.elapsedMs <= 2000).length,
          latencyMs: {
            p50: quantile(
              completed.map((t) => t.elapsedMs),
              0.5,
            ),
            p95: quantile(
              completed.map((t) => t.elapsedMs),
              0.95,
            ),
          },
          stageTimingsMs: Object.fromEntries(
            stages.map((stage) => [
              stage,
              distribution(completed.map((t) => t.result?.diagnostics?.timingsMs?.[stage])),
            ]),
          ),
          classifierLatencyMs: distribution(completed.map((t) => t.contextPlanning?.elapsedMs)),
          fallbacks: completed.filter((t) => t.contextPlanning?.status?.startsWith("fallback"))
            .length,
          errors: completed.filter((t) => t.error || t.result?.outcome === "error").length,
          inputBytes: distribution(completed.map(completeInputBytes)),
          captureBytes: distribution(completed.map((t) => t.captureObservation?.captureBytes)),
          providerCalls: calls.length,
          unknownCharges: calls.length - known.length,
          knownReportedUsd,
          reportedUsd: calls.length && known.length === calls.length ? knownReportedUsd : null,
          providers: Object.fromEntries(
            ["chat", "decision"].map((kind) => {
              const rows = calls.filter((p) => (p.kind ?? "chat") === kind);
              return [
                kind,
                {
                  calls: rows.length,
                  inputTokens: distribution(
                    rows.map((p) => p.usage?.prompt_tokens ?? p.usage?.input_tokens),
                  ),
                  outputTokens: distribution(
                    rows.map((p) => p.usage?.completion_tokens ?? p.usage?.output_tokens),
                  ),
                  remoteAccountingMs: distribution(
                    rows.map((p) =>
                      Number.isFinite(p.remoteAccountingMs?.reservation) &&
                      Number.isFinite(p.remoteAccountingMs?.reconciliation)
                        ? p.remoteAccountingMs.reservation + p.remoteAccountingMs.reconciliation
                        : null,
                    ),
                  ),
                  knownReportedUsd: rows.reduce((sum, p) => sum + (p.reportedUsd ?? 0), 0),
                  unknownCharges: rows.filter((p) => p.reportedUsd == null).length,
                },
              ];
            }),
          ),
        },
      ];
    }),
  );
  const pairs = [...new Set(plan.map((t) => t.caseId))].map((caseId) => {
    const control = trials.find((t) => t.caseId === caseId && t.arm === "control");
    const jev = trials.find((t) => t.caseId === caseId && t.arm === "jev");
    const controlBytes = completeInputBytes(control),
      jevBytes = completeInputBytes(jev);
    const bothCorrect = Boolean(control?.grade?.passed && jev?.grade?.passed);
    const delta =
      Number.isFinite(control?.elapsedMs) && Number.isFinite(jev?.elapsedMs)
        ? control.elapsedMs - jev.elapsedMs
        : null;
    return {
      caseId,
      complete: Boolean(control && jev),
      bothCorrect,
      elapsedMsReduction: bothCorrect && freshness.valid ? delta : null,
      observedElapsedMsDelta: delta,
      inputBytesReduction:
        Number.isFinite(controlBytes) && Number.isFinite(jevBytes) ? controlBytes - jevBytes : null,
    };
  });
  return {
    freshness,
    qualified: false,
    scope: "Paired current-view regression experiment; not release qualification",
    arms,
    pairs,
  };
}

// Remove optional object fields from the original C# JSON without changing its escaping or property order.
export function projectContextRequest(request, appearance, geometry) {
  const result = structuredClone(request);
  const source = request.messages[1].content;
  const expected = JSON.parse(source);
  assert.deepEqual(expected.evidenceAvailability, { appearance: "included", geometry: "included" });
  let content = source;
  const ranges = [];
  for (const match of source.matchAll(/,"(appearance|geometry)":\{/g)) {
    if (match[1] === "appearance" ? appearance : geometry) continue;
    let depth = 1,
      quoted = false,
      escaped = false,
      end = match.index + match[0].length;
    for (; end < source.length && depth; end++) {
      const ch = source[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    assert.equal(depth, 0, "Incomplete optional evidence object");
    ranges.push([match.index, end]);
  }
  for (const [start, end] of ranges.reverse())
    content = content.slice(0, start) + content.slice(end);
  for (const [field, included] of [
    ["appearance", appearance],
    ["geometry", geometry],
  ]) {
    expected.evidenceAvailability[field] = included ? "included" : "not_requested";
    if (!included) {
      for (const candidate of expected.candidates) delete candidate[field];
      content = content.replace(`"${field}":"included"`, `"${field}":"not_requested"`);
    }
  }
  assert.deepEqual(JSON.parse(content), expected, "Projection changed core candidate evidence");
  result.messages[1].content = content;
  return result;
}

function coreInput(trial) {
  const input = JSON.parse(trial.evidence.preparedProviderRequest.messages[1].content);
  delete input.evidenceAvailability;
  for (const candidate of input.candidates) {
    delete candidate.geometry;
    delete candidate.appearance;
  }
  return input;
}

export function verifyContextCore(control, jev) {
  assert.deepEqual(coreInput(control), coreInput(jev), "Planner changed core candidate inventory");
  assert.ok(
    jev.evidence.systemPrompt.startsWith(control.evidence.systemPrompt),
    "Planner changed core system contract",
  );
  assert.equal(
    jev.evidence.outputSchema,
    control.evidence.outputSchema,
    "Planner changed selector schema",
  );
}

function plannerEvidence(trial) {
  return trial.evidence?.configurationJson ? JSON.parse(trial.evidence.configurationJson) : {};
}

function deterministicProxy(fixture, timeoutMs) {
  let attemptId;
  const records = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 2_000_000) throw new Error("Request too large");
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      const body = JSON.parse(raw.toString());
      if (req.url === "/api/alpha/decisions") {
        const response = {
          model: "typesafe/jev-1.13-20260917",
          provider: "TypeSafe",
          id: `gen-dec-deterministic-${attemptId}`,
          answers: { appearance: { type: "noul", noul: 1 }, layout: { type: "noul", noul: 1 } },
          usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
        };
        records.push({ attemptId, kind: "decision", request: body, response, forwarded: false });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      } else if (req.url === "/api/v1/chat/completions") {
        const upstream = await fetch(`${fixture}/api/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: raw,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        });
        const response = await upstream.text();
        records.push({ attemptId, kind: "chat", request: body, forwarded: false });
        res.writeHead(upstream.status, { "Content-Type": "application/json" });
        res.end(response);
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch {
      res.writeHead(502);
      res.end();
    }
  });
  return {
    server,
    records,
    begin(id) {
      attemptId = id;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function parseContextOptions(args) {
  const options = {
    mode: "deterministic",
    output: resolve(".artifacts/evaluation/context-experiment"),
    timeoutMs: 45000,
  };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!["--mode", "--output", "--replay", "--timeout-ms"].includes(name))
      throw new Error(`Unknown context option: ${name}`);
    if (seen.has(name) || !args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error(`Invalid context option: ${name}`);
    seen.add(name);
    options[name.slice(2)] = args[i + 1];
  }
  if (!["deterministic", "live"].includes(options.mode))
    throw new Error("Context mode must be deterministic or live");
  if (options["timeout-ms"] != null) options.timeoutMs = Number(options["timeout-ms"]);
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 2000 ||
    options.timeoutMs > 120000
  )
    throw new Error("Invalid context client timeout");
  if (options.replay && seen.size !== 1) throw new Error("Replay cannot start an execution");
  return options;
}

async function runnerHashes() {
  return Object.fromEntries(
    await Promise.all(
      ["context-experiment.mjs", "run.mjs", "grader.mjs"].map(async (name) => [
        name,
        digest(await readFile(new URL(name, import.meta.url), "utf8")),
      ]),
    ),
  );
}

async function replay(directory) {
  const manifest = await json(join(directory, "manifest.json"));
  const { contentHash, ...body } = manifest;
  assert.equal(digest(body), contentHash, "Context manifest integrity mismatch");
  assert.deepEqual(
    manifest.runnerHashes,
    await runnerHashes(),
    "Replay requires recorded runner revision",
  );
  validateCases({ version: "1", cases: manifest.cases });
  const files = await readdir(join(directory, "trials"));
  const receipt = await json(join(directory, "execution.json"));
  const trials = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const text = await readFile(join(directory, "trials", file), "utf8");
    assert.equal(digest(text), receipt.trialHashes[file], "Context trial evidence changed");
    const trial = JSON.parse(text),
      planned = manifest.plan.find((p) => p.id === trial.id);
    assert.ok(planned, "Unplanned context attempt");
    for (const key of ["id", "caseId", "arm", "attempt", "repetition"])
      assert.equal(trial[key], planned[key], "Context trial identity mismatch");
    trial.grade = gradeTrial(
      manifest.cases.find((c) => c.id === trial.caseId),
      trial,
    );
    trials.push(trial);
  }
  const summary = summarizeContext(manifest.plan, trials);
  console.log(JSON.stringify(summary, null, 2));
  return receipt.runError ||
    summary.freshness.errors.length ||
    summary.arms.control.missing ||
    summary.arms.jev.missing ||
    (manifest.mode === "deterministic" && trials.some((t) => !t.grade.passed))
    ? 1
    : 0;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseContextOptions(args);
  if (options.replay) return replay(resolve(options.replay));
  const suite = await json(new URL("./viewport-baseline-cases.json", import.meta.url));
  const cases = validateCases(suite).filter((c) => c.contractVersion === "4");
  assert.equal(
    cases.length,
    16,
    "Context experiment requires the frozen sixteen current-view cases",
  );
  const output = resolve(options.output),
    services = {
      browser: process.env.XPATHED_BROWSER_URL ?? "http://browser:8080",
      fixture: process.env.XPATHED_FIXTURE_URL ?? "http://evaluation-fixture:8090",
      control: process.env.XPATHED_CONTROL_RESOLVER_URL ?? "http://resolver:8080",
      jev: process.env.XPATHED_JEV_RESOLVER_URL ?? "http://resolver-context:8080",
    };
  await mkdir(join(output, "trials"), { recursive: true, mode: 0o700 });
  await save(join(output, "started.json"), {
    startedAt: new Date().toISOString(),
    mode: options.mode,
  });
  const manifest = {
    version: 1,
    kind: "context-experiment",
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    mode: options.mode,
    cases,
    sourceManifestHash: digest(suite),
    profile,
    plan: buildContextPlan(cases),
    code: await fingerprints(),
    runnerHashes: await runnerHashes(),
    accounting: { version: 1, budgetPolicy: "provider-limit" },
    measurement: {
      latency:
        "Resolver HTTP; classifier/capture/final selector/verification included; durable remote accounting outside timed request",
      deadlineMs: 2000,
      retries: 0,
      qualification: false,
      rawEvidenceDays: 30,
    },
  };
  let det = deterministicProxy(services.fixture, options.timeoutMs),
    proxy,
    runError;
  const trials = [],
    prepared = new Map();
  const runTrial = async (planned, mode) => {
    const trial = { ...planned, profileId: profile.id, mode, createdAt: new Date().toISOString() };
    const spec = cases.find((c) => c.id === trial.caseId);
    if (mode === "live") {
      const binding = prepared.get(`${trial.caseId}:${trial.arm}`);
      await proxy.reserveAttempt(trial.id, profile.id, null, binding);
    } else det.begin(trial.id);
    await execute(
      spec,
      trial,
      { ...options, mode },
      { ...services, resolver: services[trial.arm] },
    );
    trial.configuration = configurationRecord(trial);
    trial.contextPlanning = plannerEvidence(trial).contextPlanning ?? null;
    if (mode === "live") {
      await proxy.awaitIdle();
      try {
        await proxy.finishAttempt();
      } catch (error) {
        trial.accountingError = error.message;
      }
      const calls = proxy.records.filter((r) => r.attemptId === trial.id);
      trial.provider = calls.map(({ request, response, ...record }) => record);
      trial.evidence = { ...trial.evidence, provider: calls };
    } else
      trial.evidence = {
        ...trial.evidence,
        classifier: det.records.filter((r) => r.attemptId === trial.id && r.kind === "decision"),
      };
    trial.grade = gradeTrial(spec, trial);
    return trial;
  };
  try {
    det.server.listen(Number(process.env.XPATHED_CONTEXT_PROXY_PORT ?? 8091), "0.0.0.0");
    await once(det.server, "listening");
    const preflight = [];
    if (options.mode === "live") await mkdir(join(output, "preflight"), { mode: 0o700 });
    const preflightPlan =
      options.mode === "live" ? buildContextPreflightPlan(manifest.plan) : manifest.plan;
    manifest.preflightPlan = preflightPlan;
    for (const planned of preflightPlan) {
      const trial = await runTrial(planned, "deterministic");
      preflight.push(trial);
      if (options.mode === "deterministic") {
        trials.push(trial);
        await save(join(output, "trials", `${trial.id}.json`), trial);
      } else await save(join(output, "preflight", `${trial.id}.json`), trial);
    }
    if (preflight.every((t) => t.grade.passed)) {
      for (const spec of cases) {
        const control = preflight.find((t) => t.caseId === spec.id && t.arm === "control"),
          jev = preflight.find((t) => t.caseId === spec.id && t.arm === "jev");
        verifyContextCore(control, jev);
        const policy = plannerEvidence(jev).effective?.contextPlanning;
        assert.ok(policy?.questions, "Planner policy missing");
        if (manifest.plannerPolicy)
          assert.deepEqual(policy, manifest.plannerPolicy, "Planner policy changed");
        else manifest.plannerPolicy = policy;
        for (const trial of [control, jev]) {
          const request = trial.evidence.preparedProviderRequest;
          assert.equal(request.model, profile.model);
          assert.deepEqual(request.provider.only, [profile.provider]);
          const preparedRequests =
            trial.arm === "control"
              ? [request]
              : [true, false].flatMap((a) =>
                  [true, false].map((g) => projectContextRequest(request, a, g)),
                );
          const decisionRequest = trial.evidence.classifier[0]?.request;
          if (trial.arm === "jev") {
            assert.equal(decisionRequest.state, spec.instruction);
            assert.equal(trial.evidence.classifier.length, 1);
          }
          prepared.set(`${spec.id}:${trial.arm}`, {
            preparedRequests,
            ...(decisionRequest ? { decisionRequest } : {}),
          });
        }
      }
    }
    manifest.preparedRequests = Object.fromEntries(prepared);
    manifest.preflight = {
      trials: preflight.length,
      correct: preflight.filter((t) => t.grade.passed).length,
    };
    await det.close();
    det = null;
    if (options.mode === "live") {
      if (preflight.some((t) => !t.grade.passed))
        throw new Error("Deterministic context preflight failed; no paid calls made");
      const { createBudgetProxy } = await import("./comparison-budget.mjs");
      await mkdir(join(output, "provider"), { mode: 0o700 });
      proxy = await createBudgetProxy({
        profiles: [profile],
        contextPlanning: true,
        ledgerPath:
          process.env.XPATHED_BUDGET_PATH ?? resolve(".artifacts/datasets/experiment-budget.json"),
        onRecord: (record) =>
          writeFile(
            join(output, "provider", `${record.id}.json`),
            JSON.stringify(record, null, 2) + "\n",
            { mode: 0o600 },
          ),
      });
      manifest.routeMetadata = proxy.profiles;
      manifest.decisionMetadata = proxy.contextPlanningMetadata;
      manifest.accounting.before = proxy.budget;
      assert.deepEqual(
        await fingerprints(),
        manifest.code,
        "Source changed during deterministic preparation",
      );
      manifest.frozenAt = new Date().toISOString();
      manifest.contentHash = digest(manifest);
      await save(join(output, "manifest.json"), manifest);
      proxy.server.listen(Number(process.env.XPATHED_CONTEXT_PROXY_PORT ?? 8091), "0.0.0.0");
      await once(proxy.server, "listening");
      for (const planned of manifest.plan) {
        const trial = await runTrial(planned, "live");
        trials.push(trial);
        await save(join(output, "trials", `${trial.id}.json`), trial);
        console.log(
          `${trial.grade.passed ? "PASS" : "FAIL"} ${trial.arm} ${trial.caseId} ${Math.round(trial.elapsedMs ?? 0)}ms`,
        );
        if (trial.accountingError) throw new Error(trial.accountingError);
        if (trial.provider.some((p) => p.identityValid === false || p.responseCacheHit))
          throw new Error("Provider identity or response reuse failed");
        const freshness = summarizeContext(manifest.plan, trials).freshness;
        if (freshness.errors.length) throw new Error(freshness.errors.join("; "));
      }
    }
  } catch (error) {
    runError = { message: error.message };
  } finally {
    await det?.close();
    await proxy?.close();
  }
  if (!manifest.contentHash) {
    manifest.contentHash = digest(manifest);
    await save(join(output, "manifest.json"), manifest);
  }
  const trialHashes = Object.fromEntries(
    await Promise.all(
      trials.map(async (t) => [
        `${t.id}.json`,
        digest(await readFile(join(output, "trials", `${t.id}.json`), "utf8")),
      ]),
    ),
  );
  await save(join(output, "execution.json"), {
    completedAt: new Date().toISOString(),
    runError,
    trialHashes,
    ...(proxy ? { budgetAfter: proxy.budget } : {}),
  });
  const summary = summarizeContext(manifest.plan, trials);
  await save(join(output, "summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
  return runError ||
    trials.length !== manifest.plan.length ||
    (options.mode === "deterministic" && trials.some((t) => !t.grade.passed))
    ? 1
    : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
