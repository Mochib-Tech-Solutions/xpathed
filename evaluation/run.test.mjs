import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPlan,
  runTrials,
  validateCases,
  parseOptions,
  prune,
  main,
  replay,
  configurationRecord,
} from "./run.mjs";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const example = {
  id: "save",
  family: "editor",
  split: "regression",
  category: "semantics",
  fixture: "editor",
  instruction: "Click Save",
  viewport: { width: 1280, height: 800 },
  review: { status: "pending" },
  expected: {
    actions: [{ step: 1, action: "click", outcome: "found", target: { selector: "button" } }],
  },
};

test("evidence-effective-configuration-excludes-page-content-and-credentials", () => {
  const record = configurationRecord({
    result: {
      configurationId: "config",
    },
    evidence: {
      systemPrompt: "system",
      outputSchema: '{"type":"object"}',
      configurationJson: JSON.stringify({
        Model: "model",
        Provider: "route",
        effective: {
          endpoint: "https://example.test/api/",
          timeoutSeconds: "30",
          stateVersion: "2",
          interactabilityVersion: "2",
          xpathVersion: "3",
          modelInputBudgetBytes: 512000,
          maximumActions: 16,
          responseCache: false,
          request: {
            model: "model",
            max_tokens: 4096,
            reasoning: { enabled: false },
            provider: { only: ["route"], allow_fallbacks: false },
            messages: [{ role: "user", content: "PRIVATE_PAGE" }],
            apiKey: "PRIVATE_KEY",
          },
        },
      }),
    },
  });
  assert.equal(record.effective.request.max_tokens, 4096);
  assert.equal(record.effective.timeoutSeconds, "30");
  assert.match(record.promptHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_PAGE|PRIVATE_KEY/);
});

test("selection-family-leakage-is-rejected-before-browser-contact", () => {
  assert.throws(
    () =>
      validateCases({
        version: "1",
        cases: [example, { ...example, id: "save-again", split: "held-out" }],
      }),
    /family.*split/i,
  );
  assert.throws(
    () => validateCases({ version: "1", cases: [{ ...example, expected: {} }] }),
    /actions/i,
  );
});

async function runWithServices(
  t,
  caseId,
  {
    captureFailure = false,
    captureScope = "current_view",
    freshFailure = false,
    freshIdentityMismatch = false,
    freshOracleLeak = false,
    viewport = { width: 1280, height: 800 },
    concurrency = 4,
  } = {},
) {
  t.mock.method(console, "log", () => {});
  const output = await mkdtemp(join(tmpdir(), "evaluation-run-"));
  let observation = null;
  const attempts = [];
  let traceId;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const path = new URL(request.url, "http://localhost").pathname;
    const send = (value, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (path === "/fixture/trial") {
      traceId = body.traceId;
      if (concurrency > 1) assert.match(traceId, /^[a-f0-9]{32}$/);
      else assert.equal(traceId, undefined);
      return send({});
    }
    if (path === "/browser/sessions") {
      assert.deepEqual(body, { browserType: "chromium" });
      return send({ sessionId: "session", pageId: "page" });
    }
    if (path === "/browser/sessions/session" && request.method === "DELETE") return send({});
    if (path === "/browser/pages/page/navigate")
      return send({ pageId: "page", documentId: "document" });
    if (path === "/browser/pages/page/capture") {
      assert.equal(body.scope, "current_view");
      return captureFailure
        ? send({ code: "capture_incomplete" }, 502)
        : send({
            pageId: "page",
            documentId: "document",
            captureId: "capture",
            scope: captureScope,
            candidates: [{ id: "candidate", label: "Save changes", tag: "button" }],
          });
    }
    if (path === "/resolver/pages/page/selections")
      return send({
        actions: body.actions.map((action) => ({
          target: { candidateId: action.candidateId, xpaths: ["//button"] },
        })),
      });
    if (path === "/fixture/command") {
      observation = {
        id: body.id,
        viewport,
        userAgent: "test-browser",
        passiveStateUnchanged: true,
        actions: (body.actions ?? []).map(() => ({ matches: [{ count: 1, intended: true }] })),
        captureCoverage: { expected: 1, found: 1 },
        modelInputCoverage: { expected: 1, found: 1 },
      };
      return send({});
    }
    if (path === "/fixture/observation") return send(observation);
    if (path === "/fixture/provider-request")
      return send(
        freshOracleLeak && attempts.length === 2
          ? { messages: [{ content: "LABEL_MANIFEST_PRIVATE_9a71" }] }
          : null,
      );
    if (path === "/resolver/internal/pages/page/resolve") {
      if (concurrency > 1) assert.equal(request.headers.traceparent?.split("-")[1], traceId);
      else assert.equal(request.headers.traceparent, undefined);
      const attemptId = request.headers["x-xpathed-attempt-id"];
      attempts.push(attemptId);
      if (freshFailure && attempts.length === 2) return send({ code: "service_unavailable" }, 503);
      const result = {
        pageId: "page",
        documentId: "document",
        attemptId: freshIdentityMismatch && attempts.length === 2 ? "wrong-attempt" : attemptId,
        traceId: "trace",
        configurationId: "config",
        action: captureFailure ? null : "click",
        outcome: captureFailure ? "error" : "found",
        actions: captureFailure
          ? []
          : [
              {
                actionId: "a1",
                order: 1,
                step: 1,
                action: "click",
                outcome: "found",
                target: {
                  candidateId: "candidate",
                  xpaths: ["//button"],
                  state: {},
                  interactability: { status: "ready", reasons: [], checks: [] },
                },
              },
            ],
        diagnostics: captureFailure ? { code: "capture_incomplete" } : {},
      };
      return send({
        result,
        evidence: {
          availability: "model_input_available",
          modelInput: captureFailure ? null : JSON.stringify({ candidates: [{ id: "candidate" }] }),
        },
      });
    }
    return send({ code: "unexpected_test_route" }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const previous = {};
  for (const [name, suffix] of [
    ["XPATHED_BROWSER_URL", "browser"],
    ["XPATHED_RESOLVER_URL", "resolver"],
    ["XPATHED_FIXTURE_URL", "fixture"],
  ]) {
    previous[name] = process.env[name];
    process.env[name] = `http://127.0.0.1:${server.address().port}/${suffix}`;
  }
  t.after(async () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(output, { recursive: true, force: true });
  });
  await main(["--case", caseId, "--output", output, "--concurrency", String(concurrency)]);
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  const trialPath = join(output, "trials", `${manifest.plan.trials[0].id}.json`);
  return { attempts, trial: JSON.parse(await readFile(trialPath, "utf8")), output, trialPath };
}

test("evidence-authored-dom-fixtures-retain-complete-identity", async (t) => {
  const { output } = await runWithServices(t, "appearance-button-above-named-control", {
    captureScope: "viewport",
  });
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  assert.ok(manifest.cases[0].fixture.tree);
  assert.equal(manifest.cases[0].fixture.sha256, undefined);
});

test("capture-coverage-failure-retains-resolver-incomplete-error", async (t) => {
  const { trial, attempts } = await runWithServices(
    t,
    "scope-large-dom-first-visible-entry-is-found",
    {
      captureFailure: true,
    },
  );
  assert.equal(attempts.length, 1);
  assert.equal(trial.captureObservation.error.code, "http_502");
  assert.equal(trial.result.diagnostics.code, "capture_incomplete");
  assert.equal(trial.error.code, "capture_scope_unverified");
});

test("locators-failed-fresh-resolution-retains-original-attempt", async (t) => {
  const { trial, attempts } = await runWithServices(
    t,
    "locators-wrapper-insertion-preserves-current-view-target",
    { freshFailure: true },
  );
  assert.equal(attempts.length, 2);
  assert.equal(trial.result.outcome, "found");
  assert.equal(trial.error, undefined);
  assert.equal(trial.mutation.fresh.id, attempts[1]);
  assert.notEqual(trial.mutation.fresh.id, trial.id);
  assert.equal(trial.mutation.fresh.error.code, "http_503");
  assert.ok(trial.mutation.fresh.elapsedMs >= 0);
  assert.ok(Number.isFinite(Date.parse(trial.mutation.fresh.createdAt)));
});

test("locators-fresh-resolution-rejects-wrong-attempt-identity", async (t) => {
  const { trial } = await runWithServices(
    t,
    "locators-wrapper-insertion-preserves-current-view-target",
    { freshIdentityMismatch: true },
  );
  assert.match(trial.mutation.fresh.error?.message ?? "", /identity mismatch/i);
});

test("locators-fresh-model-input-is-checked-for-oracle-leakage", async (t) => {
  const { trial } = await runWithServices(
    t,
    "locators-wrapper-insertion-preserves-current-view-target",
    { freshOracleLeak: true },
  );
  assert.equal(trial.observation.oracleLeak, false);
  assert.equal(trial.mutation.fresh.observation.oracleLeak, true);
});

test("scope-viewport-observations-allow-declared-tolerance", async (t) => {
  const { trial } = await runWithServices(t, "targeting-save-button-by-name", {
    viewport: { width: 1279, height: 799 },
  });
  assert.equal(trial.error, undefined);
  assert.deepEqual(trial.observation.viewport, { width: 1279, height: 799 });
});

test("scope-viewport-drift-beyond-tolerance-fails-trial", async (t) => {
  const { trial } = await runWithServices(t, "targeting-save-button-by-name", {
    viewport: { width: 1278, height: 800 },
  });
  assert.match(trial.error?.message ?? "", /viewport/i);
});

test("replay-missing-planned-trial-remains-failure", async (t) => {
  const { output, trialPath } = await runWithServices(
    t,
    "scope-large-dom-first-visible-entry-is-found",
    {
      captureFailure: true,
    },
  );
  await rm(trialPath);
  const report = await replay(output);
  assert.equal(report.passed, false);
  assert.equal(report.plannedTrials, 1);
  assert.equal(report.completedTrials, 0);
  assert.equal(report.missingTrials, 1);
});

test("planning-same-seed-schedules-every-case-once-without-retries", () => {
  const cases = [example, { ...example, id: "cancel" }];
  const plan = buildPlan(cases, { seed: 23, repetitions: 2, timeoutMs: 30000 });
  assert.deepEqual(plan, buildPlan(cases, { seed: 23, repetitions: 2, timeoutMs: 30000 }));
  assert.equal(plan.trials.length, 4);
  assert.equal(new Set(plan.trials.map((t) => `${t.caseId}:${t.repetition}`)).size, 4);
  assert.equal(plan.retries, 0);
  assert.equal(plan.concurrency, 1);
});

test("options-invalid-or-ambiguous-arguments-are-rejected-before-paid-calls", () => {
  assert.equal(parseOptions([]).mode, "deterministic");
  assert.throws(() => parseOptions(["--mode", "lve"]));
  assert.throws(() => parseOptions(["--repetitions", "0"]));
  assert.throws(() => parseOptions(["--timeout-ms", "NaN"]));
  assert.throws(() => parseOptions(["--unknown", "value"]));
});

test("retention-expired-inputs-are-erased-without-discarding-outcomes", async () => {
  const path = await mkdtemp(join(tmpdir(), "evaluation-retention-"));
  try {
    await mkdir(join(path, "trials"));
    await writeFile(
      join(path, "manifest.json"),
      JSON.stringify({
        version: "1",
        id: "retained-run",
        createdAt: "2026-08-01T00:00:00Z",
        plan: { trials: [] },
        code: { revision: "test" },
        contentHash: "original-frozen-hash",
      }),
    );
    await writeFile(
      join(path, "trials", "a.json"),
      JSON.stringify({
        result: { outcome: "found" },
        provider: [{ forwarded: true, reportedUsd: 0.001 }],
        evidence: { modelInput: "secret" },
        mutation: { fresh: { evidence: { modelInput: "secret" } } },
      }),
    );
    await writeFile(join(path, "trials", "a.json.partial"), '{"evidence":"interrupted raw input"');
    assert.equal(await prune(path, new Date("2026-08-30T00:00:00Z")), "retained");
    assert.equal(await prune(path, new Date("2026-08-31T00:00:00Z")), "evidence_deleted");
    const expired = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
    assert.equal(expired.evidenceAvailability, "expired");
    assert.equal(expired.contentHash, "original-frozen-hash");
    await assert.rejects(readFile(join(path, "trials", "a.json.partial")), { code: "ENOENT" });
    const trial = JSON.parse(await readFile(join(path, "trials", "a.json"), "utf8"));
    assert.equal(trial.evidence, null);
    assert.equal(trial.mutation.fresh.evidence, null);
    assert.equal(trial.result.outcome, "found");
    assert.deepEqual(trial.provider, [{ forwarded: true, reportedUsd: 0.001 }]);
    assert.equal(await prune(path, new Date("2026-10-30T00:00:00Z")), "records_deleted");
    await assert.rejects(readFile(join(path, "manifest.json")), { code: "ENOENT" });
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("scope-current-view-capture-rejects-wrong-scope-response", async (t) => {
  const { trial } = await runWithServices(t, "state-disabled-settings-button-is-blocked", {
    captureScope: "page",
  });
  assert.match(trial.captureObservation.error.message, /wrong scope/);
  assert.equal(trial.error.code, "capture_scope_unverified");
});

test("workers-concurrency-preserves-cap-plan-order-and-original-attempts", async () => {
  let active = 0,
    peak = 0;
  const started = [],
    completed = [];
  const trials = Array.from({ length: 9 }, (_, id) => ({ id }));
  const result = await runTrials({ trials, concurrency: 3 }, async (trial) => {
    started.push(trial.id);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, trial.id === 0 ? 40 : 5));
    active--;
    completed.push(trial.id);
    return trial.id;
  });
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.deepEqual(
    started,
    trials.map((t) => t.id),
  );
  assert.notDeepEqual(completed, result);
  assert.deepEqual(
    result,
    trials.map((t) => t.id),
  );
  assert.equal(buildPlan([example], { seed: 1, repetitions: 1, concurrency: 3 }).concurrency, 3);
});

test("workers-pending-cleanup-completes-before-infrastructure-failure-is-reported", async () => {
  let finished = false;
  await assert.rejects(
    runTrials({ trials: [0, 1], concurrency: 2 }, async (trial) => {
      if (trial === 0) throw new Error("disk full");
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished = true;
    }),
    /Evaluation worker failed/,
  );
  assert.equal(finished, true);
  for (const value of ["0", "5", "1.5", "NaN"])
    assert.throws(() => parseOptions(["--concurrency", value]), /concurrency/);
  assert.throws(() => parseOptions(["--mode", "live", "--concurrency", "2"]), /Live evaluation/);
});

test("workers-serial-execution-preserves-fixture-protocol", async (t) => {
  const { trial, attempts } = await runWithServices(
    t,
    "locators-wrapper-insertion-preserves-current-view-target",
    { concurrency: 1 },
  );
  assert.equal(attempts.length, 2);
  assert.equal(trial.error, undefined);
  assert.equal(trial.mutation.fresh.error, undefined);
});
