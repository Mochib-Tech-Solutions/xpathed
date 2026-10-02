import { loadCases } from "../cases/load.mjs";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  parseOptions,
  buildPlan,
  fingerprints,
  request,
  command,
  configurationRecord,
  execute,
} from "../run.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
import { selectQualificationCases } from "../compare.mjs";
import { gradeTrial } from "../grader.mjs";
import { gradeComparison } from "./grade.mjs";
import { workerRouter } from "./parallel-comparison.mjs";

export const arms = ["basic", "improved", "stagehand"];
export const labels = {
  basic: "Basic resolver",
  improved: "Improved resolver",
  stagehand: "Stagehand",
};

export function selectCases(caseId) {
  const all = loadCases().cases;
  const selectedId =
    caseId && (all.find((c) => c.id === caseId || c.sourceIds?.includes(caseId))?.id ?? caseId);
  return selectQualificationCases(all, { caseId: selectedId }).cases.map((c) => ({
    ...c,
    cardinality: c.cardinality ?? "singleton",
  }));
}

export function assertParity(a, b) {
  for (const key of [
    "viewport",
    "userAgent",
    "language",
    "languages",
    "timeZone",
    "initialState",
    "documentChecksum",
  ]) {
    if (a?.[key] == null || b?.[key] == null || JSON.stringify(a[key]) !== JSON.stringify(b[key]))
      throw new Error(`Browser parity mismatch: ${key}`);
  }
  if (Math.abs(a.viewport.width - 1280) > 1 || Math.abs(a.viewport.height - 800) > 1)
    throw new Error("Browser parity mismatch: required viewport");
}

export function normalizeStagehand(result) {
  const names = {
    click: "click",
    dblclick: "double_click",
    fill: "fill",
    type: "type",
    hover: "hover",
    check: "check",
    uncheck: "uncheck",
    selectOption: "select",
    press: "press",
    focus: "focus",
    blur: "blur",
    setInputFiles: "upload",
  };
  const actions = (result.targets ?? []).map((target) => ({
    action: names[target.method] ?? "unsupported",
    outcome: "found",
    target,
  }));
  return {
    outcome: result.status === "empty" ? "not_found" : result.status,
    action: actions[0]?.action ?? null,
    actions,
  };
}

export function summarize(manifest, trials) {
  const total = manifest.cases.length;
  const summary = {
    mode: manifest.mode,
    measurement:
      manifest.mode === "live"
        ? "one original attempt per case and arm"
        : "scripted adapter checks; not model accuracy",
    planned: total * arms.length,
    completed: trials.length,
    arms: {},
    categories: {},
    changes: { gained: [], lost: [] },
  };
  for (const arm of arms) {
    const rows = trials.filter((t) => t.arm === arm);
    const calls = rows.flatMap((t) => t.provider ?? []).filter((r) => r.forwarded);
    const times = rows
      .map((t) => t.elapsedMs)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    summary.arms[arm] = {
      label: labels[arm],
      total,
      attempted: rows.length,
      passed: rows.filter((t) => t.grade.passed).length,
      errors: rows.filter((t) => t.grade.metrics.operationalError).length,
      fullContractPassed:
        arm === "stagehand" ? null : rows.filter((t) => t.contractGrade?.passed).length,
      calls: calls.length,
      knownReportedUsd: calls.reduce((sum, r) => sum + (r.reportedUsd ?? 0), 0),
      unreportedCharges: calls.filter((r) => r.reportedUsd == null).length,
      latencyCohorts: Object.fromEntries(
        [...new Set(rows.map((t) => t.execution?.cohort ?? "serial"))].map((cohort) => {
          const values = rows
            .filter((t) => (t.execution?.cohort ?? "serial") === cohort)
            .map((t) => t.elapsedMs)
            .filter(Number.isFinite)
            .sort((a, b) => a - b);
          return [
            cohort,
            {
              attempts: values.length,
              p50: values[Math.ceil(values.length * 0.5) - 1] ?? null,
              p95: values[Math.ceil(values.length * 0.95) - 1] ?? null,
            },
          ];
        }),
      ),
      latencyMs: {
        p50: times[Math.ceil(times.length * 0.5) - 1] ?? null,
        p95: times[Math.ceil(times.length * 0.95) - 1] ?? null,
      },
    };
    for (const group of new Set(Object.values(manifest.groups))) {
      const ids = manifest.cases.filter((c) => manifest.groups[c.id] === group).map((c) => c.id);
      summary.categories[group] ??= {};
      summary.categories[group][arm] = {
        total: ids.length,
        passed: rows.filter((t) => ids.includes(t.caseId) && t.grade.passed).length,
      };
    }
  }
  for (const spec of manifest.cases) {
    const basic = trials.find((t) => t.arm === "basic" && t.caseId === spec.id);
    const improved = trials.find((t) => t.arm === "improved" && t.caseId === spec.id);
    if (!basic || !improved) continue;
    if (!basic.grade.passed && improved.grade.passed) summary.changes.gained.push(spec.id);
    if (basic.grade.passed && !improved.grade.passed) summary.changes.lost.push(spec.id);
  }
  summary.complete = summary.completed === summary.planned;
  return summary;
}

async function stagehandTrial(spec, trial, options, services, environment) {
  try {
    await request(
      `${services.fixture}/trial`,
      { id: trial.id, caseId: spec.id },
      options.timeoutMs,
    );
    trial.adapterEnvironment = await request(
      `${services.stagehand}/prepare`,
      {
        url: `${services.fixture}/fixture?trial=${trial.id}`,
        viewport: environment.viewport,
      },
      options.timeoutMs,
    );
    trial.environment = await command(
      services.fixture,
      trial.id,
      { kind: "baseline", setup: spec.setup ?? {} },
      options.timeoutMs,
    );
    assertParity(environment, trial.environment);
    if (trial.adapterEnvironment.browserBinarySha256 !== process.env.XPATHED_BROWSER_BINARY_SHA256)
      throw new Error("Browser parity mismatch: Chromium binary");
    const started = performance.now();
    const raw = await request(
      `${services.stagehand}/observe`,
      {
        instruction: `Within the current viewport, resolve this instruction without executing it: ${spec.instruction}`,
        cardinality: spec.cardinality,
        mode: options.mode,
        deterministic:
          options.mode === "deterministic"
            ? {
                elements: spec.provider.actions
                  .filter((a) => a.outcome === "found")
                  .map((a) => ({ ...a, role: a.tag, method: a.action })),
              }
            : undefined,
      },
      options.timeoutMs,
    );
    trial.elapsedMs = performance.now() - started;
    trial.result = normalizeStagehand(raw);
    trial.evidence = { adapter: raw };
    trial.modelCalls = raw.modelCalls;
    trial.cache = raw.metadata?.cache;
    trial.configuration = {
      version: raw.stagehandVersion,
      prompts: (raw.modelInputs ?? []).map((p) => ({
        promptHash: hash(p.systemPrompt ?? ""),
        schemaHash: hash(p.responseFormat ?? {}),
      })),
    };
    trial.observation = await command(
      services.fixture,
      trial.id,
      {
        kind: "observe",
        expected: spec.expected.actions.map((a) => a.target ?? null),
        actions: trial.result.actions,
      },
      options.timeoutMs,
    );
    const input = JSON.stringify(trial.evidence);
    trial.observation.oracleLeak = (spec.oracleSentinels ?? []).some((s) => input.includes(s));
    trial.observation.privacyLeak = (spec.privacySentinels ?? []).some((s) => input.includes(s));
  } catch (error) {
    trial.error = { message: error.message };
  } finally {
    try {
      await request(`${services.stagehand}/reset`, {}, options.timeoutMs);
    } catch (error) {
      trial.error ??= { message: `Stagehand cleanup: ${error.message}` };
    }
  }
}

export function trialId(planned, arm) {
  return hash(`${planned.id ?? `${planned.caseId}:${planned.repetition}`}-${arm}`).slice(0, 32);
}

export function assertProviderIntegrity(trial) {
  for (const record of trial.provider ?? []) {
    if (
      record.forwarded &&
      (record.responseCacheHit === true ||
        (record.status >= 200 && record.status < 300 && record.identityValid !== true))
    )
      throw new Error("Provider identity mismatch or response cache hit; comparison stopped");
  }
}

export function assertCodeIdentity(recorded, current, continuation = false) {
  const required = continuation
    ? Object.keys(current.files).filter((path) => path.startsWith("evaluation/"))
    : ["evaluation/grader.mjs", "evaluation/research/grade.mjs"];
  const paths = new Set([
    ...required,
    ...Object.keys(recorded.files).filter((path) => continuation && path.startsWith("evaluation/")),
  ]);
  for (const path of paths)
    if (!recorded.files[path] || recorded.files[path] !== current.files[path])
      throw new Error(`Comparison code identity mismatch: ${path}`);
}

export async function readTrials(directory, manifest) {
  const trials = [];
  const keys = new Set();
  for (const file of await readdir(join(directory, "trials"))) {
    const trial = await json(join(directory, "trials", file));
    if (trial.mode !== manifest.mode) continue;
    const planned = manifest.plan.trials.find(
      (p) => p.caseId === trial.caseId && p.repetition === trial.repetition,
    );
    const originalFirst =
      manifest.version === 2 &&
      planned === manifest.plan.trials[0] &&
      trial.id === hash(`undefined-${trial.arm}`).slice(0, 32);
    const key = `${trial.caseId}:${trial.arm}`;
    if (
      !planned ||
      !arms.includes(trial.arm) ||
      (!originalFirst && trial.id !== trialId(planned, trial.arm)) ||
      file !== `${trial.id}.json` ||
      keys.has(key)
    )
      throw new Error("Trial identity mismatch or duplicate attempt");
    keys.add(key);
    assertProviderIntegrity(trial);
    const spec = manifest.cases.find((c) => c.id === trial.caseId);
    trial.grade = gradeComparison(spec, trial);
    if (trial.arm !== "stagehand") trial.contractGrade = gradeTrial(spec, trial);
    trials.push(trial);
  }
  return trials;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.concurrency !== 1 || options.repetitions !== 1)
    throw new Error("Engineering comparison uses one attempt per case and arm, concurrency 1");
  const graderHash = hash(await readFile(new URL("./grade.mjs", import.meta.url)));
  if (options.replay) {
    const manifest = await json(join(options.replay, "manifest.json"));
    const { contentHash, ...body } = manifest;
    if (hash(body) !== contentHash || manifest.graderHash !== graderHash)
      throw new Error("Comparison manifest/grader integrity mismatch");
    assertCodeIdentity(manifest.code, await fingerprints());
    const trials = await readTrials(options.replay, manifest);
    console.log(JSON.stringify(summarize(manifest, trials), null, 2));
    return trials.length === manifest.plan.trials.length * arms.length ? 0 : 1;
  }
  if (options.prune) throw new Error("Use the ordinary evaluation prune command");
  const cases = selectCases(options.caseId);
  const groups = {};
  for (const group of loadCases().groups)
    for (const spec of await json(new URL(`../cases/${group}`, import.meta.url)))
      groups[spec.id] = group.replace(".json", "");
  const output = resolve(options.output);
  await mkdir(join(output, "trials"), { recursive: true, mode: 0o700 });
  let manifest = {
    version: 3,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    mode: options.mode,
    cases,
    groups,
    plan: buildPlan(cases, options),
    code: await fingerprints(),
    graderHash,
    artifacts: JSON.parse(process.env.XPATHED_ENGINEERING_ARTIFACTS ?? "null"),
    browserBinarySha256: process.env.XPATHED_BROWSER_BINARY_SHA256,
    stagehand: {
      version: "4.1.0",
      packageLockHash: hash(
        await readFile(new URL("./stagehand/package-lock.json", import.meta.url)),
      ),
    },
    policy: {
      selection: "first singleton; whole plural set",
      actionExecution: false,
      retries: 0,
      responseReuse: false,
      comparison: "whole configurations; prompts and DOM representations differ",
      retentionDays: 90,
      evidenceDays: 30,
    },
  };
  if (!manifest.artifacts || !manifest.browserBinarySha256)
    throw new Error("Run through the verified engineering comparison launcher");
  manifest.contentHash = hash(manifest);
  const resume = process.env.XPATHED_COMPARISON_RESUME === "true";
  let retained = [];
  if (resume) {
    const current = manifest;
    manifest = await json(join(output, "manifest.json"));
    const { contentHash, ...body } = manifest;
    if (
      hash(body) !== contentHash ||
      manifest.graderHash !== graderHash ||
      manifest.mode !== options.mode ||
      hash(manifest.cases) !== hash(cases) ||
      hash(manifest.artifacts) !== hash(current.artifacts) ||
      manifest.browserBinarySha256 !== current.browserBinarySha256 ||
      hash(manifest.stagehand) !== hash(current.stagehand)
    )
      throw new Error("Continuation requires unchanged cases, grading, settings and images");
    assertCodeIdentity(manifest.code, current.code, true);
    if (hash(manifest.plan) !== hash(current.plan))
      throw new Error("Continuation requires the original plan and timeout settings");
    retained = await readTrials(output, manifest);
    for (const file of await readdir(join(output, "provider"))) {
      const record = await json(join(output, "provider", file));
      if (!retained.some((t) => t.id === record.attemptId))
        throw new Error(
          "An original provider attempt has no retained result; recover its evidence before continuing",
        );
    }
    await save(join(output, `continuation-${randomUUID()}.json`), {
      createdAt: new Date().toISOString(),
      originalManifestHash: contentHash,
      code: current.code,
      artifacts: current.artifacts,
      retainedIds: retained.map((t) => t.id),
      execution: { concurrency: 3, workers: "one isolated stream per arm" },
      reason: "Continue only unattempted cases; original attempts remain unchanged",
    });
  } else await save(join(output, "manifest.json"), manifest);
  const services = {
    browser: "http://browser:8080",
    resolver: "http://resolver:8080",
    fixture: "http://evaluation-fixture:8090",
    stagehand: "http://stagehand:8092",
  };
  const trials = [];
  const proxies = [];
  let router, deterministicProxy;
  let failure;
  const basicReady = new Map(manifest.plan.trials.map((p) => [p.caseId, Promise.withResolvers()]));
  let summaryWrite = Promise.resolve();
  async function runCase(spec, planned, mode, onlyArm) {
    const rows = [];
    for (const arm of onlyArm ? [onlyArm] : arms) {
      const previous = retained.find((t) => t.caseId === spec.id && t.arm === arm);
      if (previous && mode === manifest.mode) {
        rows.push(previous);
        if (arm === "basic") basicReady.get(spec.id)?.resolve(previous);
        continue;
      }
      const basic =
        arm === "stagehand" ? (onlyArm ? await basicReady.get(spec.id).promise : rows[0]) : null;
      if (failure) return rows;
      const trial = {
        ...planned,
        id: trialId(planned, arm),
        arm,
        strategy: arm === "stagehand" ? "stagehand" : "custom",
        mode,
        cardinality: spec.cardinality,
        createdAt: new Date().toISOString(),
        execution: {
          cohort: onlyArm ? "parallel" : "serial",
          concurrency: onlyArm ? 3 : 1,
          worker: arm,
        },
      };
      const proxy = proxies[arms.indexOf(arm)];
      if (mode === "live") proxy.beginAttempt(trial.id);
      if (arm === "stagehand")
        await stagehandTrial(spec, trial, { ...options, mode }, services, basic.environment);
      else {
        const endpoints =
          arm === "basic"
            ? {
                ...services,
                browser: "http://browser-basic:8080",
                resolver: "http://resolver-basic:8080",
              }
            : services;
        await execute(spec, trial, { ...options, mode }, endpoints);
        trial.modelCalls = trial.result?.diagnostics?.modelCalls ?? null;
        trial.configuration = configurationRecord(trial);
      }
      if (mode === "live") {
        await proxy.awaitIdle();
        const calls = proxy.records.filter((r) => r.attemptId === trial.id);
        trial.evidence = { ...trial.evidence, provider: calls };
        trial.provider = calls.map(({ request, response, ...metadata }) => metadata);
        try {
          assertProviderIntegrity(trial);
        } catch (error) {
          failure ??= error;
          trial.error ??= { message: error.message };
          for (const ready of basicReady.values()) ready.resolve({});
        }
      }
      if (arm === "improved")
        try {
          assertParity(
            (onlyArm ? await basicReady.get(spec.id).promise : rows[0]).environment,
            trial.environment,
          );
        } catch (error) {
          trial.error ??= { message: error.message };
        }
      if (arm !== "stagehand") trial.contractGrade = gradeTrial(spec, trial);
      trial.grade = gradeComparison(spec, trial);
      await save(join(output, "trials", `${trial.id}.json`), trial);
      rows.push(trial);
      if (arm === "basic") basicReady.get(spec.id)?.resolve(trial);
      console.log(
        `${arm}: ${spec.id}: ${trial.grade.passed ? "pass" : trial.grade.failures.map((f) => f.category).join(", ")}`,
      );
    }
    return rows;
  }
  try {
    deterministicProxy = createServer(async (req, res) => {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 2_000_000) throw new Error("Request too large");
          chunks.push(chunk);
        }
        const upstream = await fetch(`${services.fixture}${req.url}`, {
          method: req.method,
          headers: { "Content-Type": "application/json" },
          body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        res.writeHead(upstream.status, { "Content-Type": "application/json" });
        res.end(await upstream.text());
      } catch {
        res.writeHead(502);
        res.end();
      }
    });
    deterministicProxy.listen(8091, "0.0.0.0");
    await once(deterministicProxy, "listening");
    if (options.mode === "live") {
      let gates = [];
      if (resume) gates = await json(join(output, "compatibility.json"));
      else {
        for (const id of ["basic-save", "single-action-plural-confirmations"]) {
          const spec = selectCases().find((c) => c.id === id || c.sourceIds?.includes(id));
          if (!spec) throw new Error(`Missing compatibility case: ${id}`);
          gates.push(
            ...(await runCase(
              spec,
              { id: randomUUID(), caseId: spec.id, repetition: 1, attempt: 1 },
              "deterministic",
            )),
          );
        }
        await save(
          join(output, "compatibility.json"),
          gates.map(({ id, caseId, arm, grade }) => ({ id, caseId, arm, grade })),
        );
      }
      if (!gates.every((t) => t.grade.passed))
        throw new Error("Deterministic compatibility gate failed; no paid calls made");
      await new Promise((resolve) => deterministicProxy.close(resolve));
      deterministicProxy = undefined;
      const { createBudgetProxy } = await import("../provider.mjs");
      await mkdir(join(output, "provider"), { recursive: true });
      for (const arm of arms) {
        const proxy = await createBudgetProxy({
          ledgerPath: join(output, `accounting-${arm}.json`),
          githubRepository: "",
          githubToken: "",
          onRecord: (record) =>
            writeFile(
              join(output, "provider", `${record.id}.json`),
              JSON.stringify(record, null, 2) + "\n",
              { mode: 0o600 },
            ),
        });
        proxies.push(proxy);
        proxy.server.listen(0, "127.0.0.1");
        await once(proxy.server, "listening");
      }
      router = workerRouter(
        proxies.map((p) => p.server.address().port),
        { "comparison-only": 2 },
      );
      router.listen(8091, "0.0.0.0");
      await once(router, "listening");
    }
    const record = async (rows) => {
      trials.push(...rows);
      summaryWrite = summaryWrite.then(() =>
        writeFile(
          join(output, "summary.json"),
          JSON.stringify(summarize(manifest, trials), null, 2) + "\n",
          { mode: 0o600 },
        ),
      );
      await summaryWrite;
    };
    if (options.mode === "live") {
      await Promise.all(
        arms.map(async (arm) => {
          for (const planned of manifest.plan.trials) {
            if (failure) break;
            try {
              await record(
                await runCase(
                  cases.find((c) => c.id === planned.caseId),
                  planned,
                  options.mode,
                  arm,
                ),
              );
            } catch (error) {
              failure ??= error;
              for (const ready of basicReady.values()) ready.resolve({});
            }
          }
        }),
      );
      if (failure) throw failure;
    } else
      for (const planned of manifest.plan.trials)
        await record(
          await runCase(
            cases.find((c) => c.id === planned.caseId),
            planned,
            options.mode,
          ),
        );
    console.log(JSON.stringify(summarize(manifest, trials), null, 2));
    return 0;
  } finally {
    if (router) await new Promise((resolve) => router.close(resolve));
    await Promise.all(proxies.map((p) => p.close()));
    if (deterministicProxy) await new Promise((resolve) => deterministicProxy.close(resolve));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname)
  main()
    .then((code) => (process.exitCode = code))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
