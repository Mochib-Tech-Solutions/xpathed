import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
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
} from "./run.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const ids = [
  "basic-save",
  "paraphrase-save",
  "unicode-quotes",
  "scoped-save",
  "offscreen-help",
  "covered-payment",
  "transparent-control",
  "hidden-absence",
  "true-absence",
  "page-injection",
  "nested-frame",
  "single-action-plural-confirmations",
];
const source = await json(new URL("./cases.json", import.meta.url));

export function selectCases(caseId) {
  if (caseId && !ids.includes(caseId)) throw new Error("Unknown comparison case");
  return (caseId ? [caseId] : ids).map((id) => {
    const item = structuredClone(source.cases.find((entry) => entry.id === id));
    item.contractVersion = "3";
    item.cardinality = id === "single-action-plural-confirmations" ? "all" : "singleton";
    return item;
  });
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

export function summarizePairs(manifest, trials) {
  const report = {
    version: 1,
    mode: manifest.mode,
    qualification: "incomplete",
    measurement:
      manifest.mode === "live"
        ? "paired first-observation comparison"
        : "deterministic adapter compatibility, not model quality",
    planned: manifest.plan.trials.length * 2,
    completed: trials.length,
    strategies: {},
  };
  for (const strategy of ["custom", "stagehand"]) {
    const rows = trials.filter((trial) => trial.strategy === strategy);
    const calls = rows.flatMap((t) => t.provider ?? []);
    const paid = calls.filter((r) => r.forwarded);
    const total = (cardinality) =>
      manifest.plan.trials.filter(
        (t) => manifest.cases.find((c) => c.id === t.caseId)?.cardinality === cardinality,
      ).length;
    const sumUsage = (get) =>
      paid.every((r) => typeof get(r.usage) === "number")
        ? paid.reduce((sum, r) => sum + get(r.usage), 0)
        : null;
    const quantile = (values, fraction) =>
      values.length
        ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]
        : null;
    report.strategies[strategy] = {
      attempted: rows.length,
      missing: manifest.plan.trials.length - rows.length,
      singleton: {
        passed: rows.filter((t) => t.cardinality === "singleton" && t.grade.passed).length,
        total: total("singleton"),
      },
      plural: {
        passed: rows.filter((t) => t.cardinality === "all" && t.grade.passed).length,
        total: total("all"),
      },
      metrics: rows.reduce((sum, t) => {
        for (const [key, value] of Object.entries(t.grade.metrics ?? {}))
          if (typeof value === "number") sum[key] = (sum[key] ?? 0) + value;
        return sum;
      }, {}),
      errors: rows.filter((t) => t.error || t.grade.metrics.operationalError).length,
      unsupported: rows.filter((t) => t.grade.metrics.unsupported).length,
      latencyMs: {
        p50: quantile(rows.map((t) => t.elapsedMs).filter(Number.isFinite), 0.5),
        p95: quantile(rows.map((t) => t.elapsedMs).filter(Number.isFinite), 0.95),
      },
      calls: paid.length,
      unreportedCharges: rows
        .flatMap((t) => t.provider ?? [])
        .filter((r) => r.reservedUsd != null && r.reportedUsd == null).length,
      usage: {
        prompt_tokens: sumUsage((u) => u?.prompt_tokens),
        completion_tokens: sumUsage((u) => u?.completion_tokens),
        total_tokens: sumUsage((u) => u?.total_tokens),
        cached_tokens: sumUsage((u) => u?.prompt_tokens_details?.cached_tokens),
      },
      reportedUsd: rows
        .flatMap((t) => t.provider ?? [])
        .some((r) => r.reservedUsd != null && r.reportedUsd == null)
        ? null
        : rows.flatMap((t) => t.provider ?? []).reduce((sum, r) => sum + (r.reportedUsd ?? 0), 0),
      knownReportedUsd: rows
        .flatMap((t) => t.provider ?? [])
        .reduce((sum, r) => sum + (r.reportedUsd ?? 0), 0),
      unavailable:
        strategy === "stagehand" ? ["xpathed readiness", "capture/model-input coverage"] : [],
    };
  }
  report.commonCoverage = manifest.plan.trials.filter((p) =>
    ["custom", "stagehand"].every((s) =>
      trials.some(
        (t) =>
          t.caseId === p.caseId &&
          t.repetition === p.repetition &&
          t.strategy === s &&
          !t.error &&
          !t.grade.metrics.operationalError &&
          !t.grade.metrics.unsupported,
      ),
    ),
  ).length;
  report.passed = trials.length === report.planned && trials.every((t) => t.grade.passed);
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const { gradeComparison } = await import("./comparison-grade.mjs");
  const runnerHash = hash(await readFile(new URL("./compare.mjs", import.meta.url), "utf8"));
  const graderHash = hash(
    await readFile(new URL("./comparison-grade.mjs", import.meta.url), "utf8"),
  );
  if (options.replay) {
    const manifest = await json(join(options.replay, "manifest.json"));
    const { contentHash, ...body } = manifest;
    if (
      hash(body) !== contentHash ||
      manifest.graderHash !== graderHash ||
      manifest.runnerHash !== runnerHash
    )
      throw new Error("Comparison manifest/grader integrity mismatch");
    const trials = [];
    for (const p of manifest.plan.trials)
      for (const strategy of ["custom", "stagehand"]) {
        try {
          const t = await json(join(options.replay, "trials", `${p.id}-${strategy}.json`));
          if (t.id !== `${p.id}-${strategy}` || t.caseId !== p.caseId || t.strategy !== strategy)
            throw new Error("Trial identity mismatch");
          t.mode = manifest.mode;
          t.grade = gradeComparison(
            manifest.cases.find((c) => c.id === t.caseId),
            t,
          );
          trials.push(t);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    const report = summarizePairs(manifest, trials);
    console.log(JSON.stringify(report, null, 2));
    return report.passed ? 0 : 1;
  }
  if (options.prune) throw new Error("Use the ordinary evaluation prune command");
  const cases = selectCases(options.caseId);
  const output = resolve(options.output);
  await mkdir(join(output, "trials"), { recursive: true, mode: 0o700 });
  const manifest = {
    version: "1",
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    mode: options.mode,
    cases,
    plan: buildPlan(cases, options),
    code: await fingerprints(),
    graderHash,
    runnerHash,
    browserBinarySha256: process.env.XPATHED_BROWSER_BINARY_SHA256 ?? null,
    stagehand: {
      version: "4.1.0",
      packageLockHash: hash(
        await readFile(new URL("./stagehand/package-lock.json", import.meta.url), "utf8"),
      ),
    },
    policy: {
      selection: "first singleton; whole explicit plural set",
      actionExecution: false,
      retries: 0,
      responseReuse: false,
      comparison: "whole configurations; strategy prompts and DOM representations differ",
      retentionDays: 90,
      evidenceDays: 30,
    },
  };
  manifest.plan.trials = manifest.plan.trials.map((t) => ({ ...t, id: randomUUID() }));
  manifest.contentHash = hash(manifest);
  await save(join(output, "manifest.json"), manifest);
  const services = {
    browser: process.env.EVALUATION_BROWSER_URL ?? "http://browser:8080",
    resolver: process.env.EVALUATION_RESOLVER_URL ?? "http://resolver:8080",
    fixture: process.env.EVALUATION_FIXTURE_URL ?? "http://evaluation-fixture:8090",
    stagehand: process.env.EVALUATION_STAGEHAND_URL ?? "http://stagehand:8092",
  };
  const trials = [];
  let proxy;
  let deterministicProxy;
  async function pair(spec, planned, mode) {
    const arms = ["custom", "stagehand"].map((strategy) => ({
      ...planned,
      id: `${planned.id}-${strategy}`,
      strategy,
      mode,
      attemptId: hash(`${planned.id}-${strategy}`).slice(0, 32),
      cardinality: spec.cardinality,
      createdAt: new Date().toISOString(),
    }));
    let session, page;
    try {
      for (const arm of arms)
        await request(
          `${services.fixture}/trial`,
          { id: arm.id, caseId: spec.id },
          options.timeoutMs,
        );
      session = await request(`${services.browser}/sessions`, {}, options.timeoutMs);
      page = await request(
        `${services.browser}/pages/${session.pageId}/navigate`,
        { url: `${services.fixture}/fixture?trial=${arms[0].id}` },
        options.timeoutMs,
      );
      arms[0].environment = await command(
        services.fixture,
        arms[0].id,
        { kind: "baseline", setup: spec.setup ?? {} },
        options.timeoutMs,
      );
      arms[1].adapterEnvironment = await request(
        `${services.stagehand}/prepare`,
        {
          url: `${services.fixture}/fixture?trial=${arms[1].id}`,
          viewport: arms[0].environment.viewport,
        },
        options.timeoutMs,
      );
      for (const arm of arms.slice(1))
        arm.environment = await command(
          services.fixture,
          arm.id,
          { kind: "baseline", setup: spec.setup ?? {} },
          options.timeoutMs,
        );
      assertParity(arms[0].environment, arms[1].environment);
      if (
        !process.env.XPATHED_BROWSER_BINARY_SHA256 ||
        arms[1].adapterEnvironment.browserBinarySha256 !== process.env.XPATHED_BROWSER_BINARY_SHA256
      )
        throw new Error("Browser parity mismatch: Chromium binary");
      // Alternate arm order by repetition; preparation and independent grading are not timed.
      const order = planned.repetition % 2 ? arms : [...arms].reverse();
      for (const arm of order) {
        const start = performance.now();
        try {
          if (mode === "live") proxy.beginAttempt(arm.id);
          if (arm.strategy === "custom") {
            const envelope = await request(
              `${services.resolver}/internal/pages/${session.pageId}/resolve`,
              { instruction: spec.instruction, documentId: page.documentId, contractVersion: "3" },
              options.timeoutMs,
              { "X-Xpathed-Attempt-Id": arm.attemptId },
            );
            arm.result = envelope.result;
            arm.evidence = envelope.evidence;
            arm.configuration = configurationRecord(arm);
            arm.modelCalls = arm.result.diagnostics?.modelCalls ?? null;
            if (
              arm.result.pageId !== session.pageId ||
              arm.result.documentId !== page.documentId ||
              arm.result.attemptId !== arm.attemptId
            )
              throw new Error("Resolution identity mismatch");
          } else {
            const raw = await request(
              `${services.stagehand}/observe`,
              {
                instruction: spec.instruction,
                cardinality: spec.cardinality,
                mode,
                deterministic:
                  mode === "deterministic"
                    ? {
                        elements: spec.provider.actions
                          .filter((a) => a.outcome === "found")
                          .map((a) => ({
                            ...a,
                            role: a.tag,
                            method: a.action,
                            index: ["scoped-save", "nested-frame"].includes(spec.id)
                              ? 1
                              : (a.index ?? 0),
                          })),
                      }
                    : undefined,
              },
              options.timeoutMs,
            );
            arm.result = normalizeStagehand(raw);
            arm.evidence = { adapter: raw };
            arm.modelCalls = raw.modelCalls ?? null;
            arm.cache = raw.metadata?.cache ?? null;
            arm.configuration = {
              strategy: "stagehand",
              version: raw.stagehandVersion,
              prompts: (raw.modelInputs ?? []).map((input) => ({
                promptHash: hash(input.systemPrompt ?? ""),
                schemaHash: hash(input.responseFormat ?? {}),
              })),
            };
          }
          arm.elapsedMs = performance.now() - start;
          arm.observation = await command(
            services.fixture,
            arm.id,
            {
              kind: "observe",
              expected: spec.expected.actions.map((a) => a.target ?? null),
              actions: arm.result.actions,
            },
            options.timeoutMs,
          );
          const input = JSON.stringify(arm.evidence);
          arm.observation.oracleLeak = (spec.oracleSentinels ?? []).some((s) => input.includes(s));
          arm.observation.privacyLeak = (spec.privacySentinels ?? []).some((s) =>
            input.includes(s),
          );
        } catch (error) {
          arm.error = { message: error.message };
          arm.elapsedMs ??= performance.now() - start;
        }
        if (mode === "live") {
          await proxy.awaitIdle();
          const calls = proxy.records.filter((r) => r.attemptId === arm.id);
          arm.evidence = { ...arm.evidence, provider: calls };
          arm.provider = calls.map(({ request, response, ...metadata }) => metadata);
        }
      }
    } catch (error) {
      for (const arm of arms) arm.error ??= { message: error.message };
    } finally {
      try {
        if (session) {
          const response = await fetch(`${services.browser}/sessions/${session.sessionId}`, {
            method: "DELETE",
            signal: AbortSignal.timeout(options.timeoutMs),
          });
          if (!response.ok) throw new Error(`Browser cleanup HTTP ${response.status}`);
        }
      } catch (error) {
        arms[0].error ??= { message: error.message };
      }
      try {
        await request(`${services.stagehand}/reset`, {}, options.timeoutMs);
      } catch (error) {
        arms[1].error ??= { message: `Stagehand cleanup: ${error.message}` };
      }
    }
    for (const arm of arms) {
      arm.grade = gradeComparison(spec, arm);
      await save(join(output, "trials", `${arm.id}.json`), arm);
    }
    return arms;
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
      const gates = [];
      for (const caseId of ["basic-save", "single-action-plural-confirmations"]) {
        const spec = selectCases(caseId)[0];
        gates.push(
          ...(await pair(
            spec,
            { id: `compatibility-${randomUUID()}`, caseId, repetition: 1, attempt: 1 },
            "deterministic",
          )),
        );
      }
      await save(
        join(output, "compatibility.json"),
        gates.map(({ id, caseId, strategy, grade }) => ({ id, caseId, strategy, grade })),
      );
      if (!gates.every((t) => t.grade.passed))
        throw new Error("Deterministic compatibility gate failed; no paid calls made");
      await new Promise((resolve) => deterministicProxy.close(resolve));
      deterministicProxy = undefined;
      const { createBudgetProxy } = await import("./comparison-budget.mjs");
      await mkdir(join(output, "provider"));
      proxy = await createBudgetProxy({
        ledgerPath:
          process.env.XPATHED_BUDGET_PATH ?? resolve(".artifacts/datasets/experiment-budget.json"),
        onRecord: async (record) => {
          await writeFile(
            join(output, "provider", `${record.id}.json`),
            JSON.stringify(record, null, 2) + "\n",
            { mode: 0o600 },
          );
        },
      });
      proxy.server.listen(8091, "0.0.0.0");
      await once(proxy.server, "listening");
    }
    for (const planned of manifest.plan.trials) {
      trials.push(
        ...(await pair(
          cases.find((c) => c.id === planned.caseId),
          planned,
          options.mode,
        )),
      );
    }
    const report = summarizePairs(manifest, trials);
    await save(join(output, "summary.json"), report);
    console.log(JSON.stringify(report, null, 2));
    return report.passed ? 0 : 1;
  } finally {
    await proxy?.close();
    if (deterministicProxy) await new Promise((resolve) => deterministicProxy.close(resolve));
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
