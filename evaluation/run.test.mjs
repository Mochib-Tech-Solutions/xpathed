import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPlan,
  validateCases,
  parseOptions,
  toArtifact,
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
  setupRevision: "1",
  viewport: { width: 1280, height: 800 },
  review: { status: "pending" },
  expected: {
    actions: [{ step: 1, action: "click", outcome: "found", target: { selector: "button" } }],
  },
};

test("paired viewport suites require complete equivalent pairs and separate changed-scope labels", () => {
  const cases = ["3", "4"].map((contractVersion) => ({
    ...structuredClone(example),
    id: `save-${contractVersion}`,
    contractVersion,
    baselineStratum: "paired",
    pairId: "save",
    split: "development",
  }));
  const suite = { version: "1", baseline: { version: 1, kind: "viewport-paired" }, cases };
  assert.equal(validateCases(suite).length, 2);
  assert.throws(() => validateCases({ ...suite, cases: cases.slice(0, 1) }), /pair/);
  const altered = structuredClone(suite);
  altered.cases[1].expected.actions[0].target.selector = "#another";
  assert.throws(() => validateCases(altered), /pair/);
  assert.throws(
    () => validateCases({ ...suite, cases: cases.map((c) => ({ ...c, split: "held-out" })) }),
    /development|regression/,
  );
});

test("durable run configuration keeps effective settings but excludes page content and credentials", () => {
  const record = configurationRecord({
    result: {
      configurationId: "config",
      diagnostics: { model: "model", provider: "route", strategy: "strategy", promptVersion: "6" },
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
          captureVersion: "4",
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

test("the run rejects family leakage before contacting the browser", () => {
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
    contractVersion = "2",
    captureScope = "page",
    freshFailure = false,
    freshIdentityMismatch = false,
    freshOracleLeak = false,
    viewport = { width: 1280, height: 800 },
  } = {},
) {
  t.mock.method(console, "log", () => {});
  const output = await mkdtemp(join(tmpdir(), "evaluation-run-"));
  let observation = null;
  const attempts = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const path = new URL(request.url, "http://localhost").pathname;
    const send = (value, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (path === "/fixture/trial") return send({});
    if (path === "/browser/sessions") return send({ sessionId: "session", pageId: "page" });
    if (path === "/browser/sessions/session" && request.method === "DELETE") return send({});
    if (path === "/browser/pages/page/navigate")
      return send({ pageId: "page", documentId: "document" });
    if (path === "/browser/pages/page/capture") {
      if (contractVersion === "4") assert.equal(body.scope, "current_view");
      return captureFailure
        ? send({ code: "capture_budget_exceeded" }, 502)
        : send({
            pageId: "page",
            documentId: "document",
            captureId: "capture",
            scope: captureScope,
            candidates: [{ id: "candidate", label: "Save changes", tag: "button" }],
          });
    }
    if (path === "/browser/pages/page/selections")
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
      const attemptId = request.headers["x-xpathed-attempt-id"];
      attempts.push(attemptId);
      if (freshFailure && attempts.length === 2) return send({ code: "service_unavailable" }, 503);
      const result = {
        contractVersion,
        pageId: "page",
        documentId: "document",
        attemptId: freshIdentityMismatch && attempts.length === 2 ? "wrong-attempt" : attemptId,
        traceId: "trace",
        configurationId: "config",
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
  await main(["--case", caseId, "--output", output]);
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  const trialPath = join(output, "trials", `${manifest.plan.trials[0].id}.json`);
  return { attempts, trial: JSON.parse(await readFile(trialPath, "utf8")), output, trialPath };
}

test("authored static DOM fixtures retain their complete identity in CI evidence", async (t) => {
  const { output } = await runWithServices(t, "above-reference-v4", {
    contractVersion: "4",
    captureScope: "viewport",
  });
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  assert.ok(manifest.cases[0].fixture.tree);
  assert.equal(manifest.cases[0].fixture.sha256, undefined);
});

test("a failed coverage capture still records the resolver's capture-budget result", async (t) => {
  const { trial, attempts } = await runWithServices(t, "capture-budget", { captureFailure: true });
  assert.equal(attempts.length, 1);
  assert.equal(trial.captureObservation.error.code, "http_502");
  assert.equal(trial.result.diagnostics.code, "capture_incomplete");
  assert.equal(trial.error, undefined);
});

test("a failed fresh resolution persists its own attempt without replacing the original result", async (t) => {
  const { trial, attempts } = await runWithServices(t, "mutation-wrapper", { freshFailure: true });
  assert.equal(attempts.length, 2);
  assert.equal(trial.result.outcome, "found");
  assert.equal(trial.error, undefined);
  assert.equal(trial.mutation.fresh.id, attempts[1]);
  assert.notEqual(trial.mutation.fresh.id, trial.id);
  assert.equal(trial.mutation.fresh.error.code, "http_503");
  assert.ok(trial.mutation.fresh.elapsedMs >= 0);
  assert.ok(Number.isFinite(Date.parse(trial.mutation.fresh.createdAt)));
});

test("fresh mutation results with the wrong attempt identity fail closed", async (t) => {
  const { trial } = await runWithServices(t, "mutation-wrapper", { freshIdentityMismatch: true });
  assert.match(trial.mutation.fresh.error?.message ?? "", /identity mismatch/i);
});

test("the fresh mutation provider input is checked for oracle labels independently", async (t) => {
  const { trial } = await runWithServices(t, "mutation-wrapper", { freshOracleLeak: true });
  assert.equal(trial.observation.oracleLeak, false);
  assert.equal(trial.mutation.fresh.observation.oracleLeak, true);
});

test("viewport observations retain tolerated geometry and reject larger drift", async (t) => {
  const { trial } = await runWithServices(t, "capture-budget", {
    captureFailure: true,
    viewport: { width: 1279, height: 799 },
  });
  assert.equal(trial.error, undefined);
  assert.deepEqual(trial.observation.viewport, { width: 1279, height: 799 });
});

test("viewport drift beyond the declared tolerance fails the trial", async (t) => {
  const { trial } = await runWithServices(t, "capture-budget", {
    captureFailure: true,
    viewport: { width: 1278, height: 800 },
  });
  assert.match(trial.error?.message ?? "", /viewport/i);
});

test("replay counts a missing planned trial as a failure rather than dropping it", async (t) => {
  const { output, trialPath } = await runWithServices(t, "capture-budget", {
    captureFailure: true,
  });
  await rm(trialPath);
  const report = await replay(output);
  assert.equal(report.passed, false);
  assert.equal(report.plannedTrials, 1);
  assert.equal(report.completedTrials, 0);
  assert.equal(report.missingTrials, 1);
});

test("the same seed plans every case and repetition once without retries", () => {
  const cases = [example, { ...example, id: "cancel" }];
  const plan = buildPlan(cases, { seed: 23, repetitions: 2, timeoutMs: 30000 });
  assert.deepEqual(plan, buildPlan(cases, { seed: 23, repetitions: 2, timeoutMs: 30000 }));
  assert.equal(plan.trials.length, 4);
  assert.equal(new Set(plan.trials.map((t) => `${t.caseId}:${t.repetition}`)).size, 4);
  assert.equal(plan.retries, 0);
  assert.equal(plan.concurrency, 1);
});

test("invalid or ambiguous command options cannot accidentally make paid calls", () => {
  assert.equal(parseOptions([]).mode, "deterministic");
  assert.throws(() => parseOptions(["--mode", "lve"]));
  assert.throws(() => parseOptions(["--repetitions", "0"]));
  assert.throws(() => parseOptions(["--timeout-ms", "NaN"]));
  assert.throws(() => parseOptions(["--unknown", "value"]));
});

test("importable artifacts keep model input only inside expiring evidence", () => {
  const trial = {
    id: "a".repeat(32),
    caseId: "save",
    createdAt: "2026-09-30T12:00:00Z",
    result: { pageId: "page", traceId: "trace", configurationId: "config", outcome: "found" },
    evidence: { modelInput: "synthetic" },
    observation: { actions: [] },
    elapsedMs: 20,
  };
  const artifact = toArtifact({ code: { revision: "revision" }, id: "run" }, trial, {
    passed: true,
  });
  assert.equal(artifact.kind, "evaluation");
  assert.equal(artifact.provenance.caseId, "save");
  assert.equal(artifact.result.evidence, undefined);
  assert.equal(artifact.evidence.modelInput, "synthetic");
  assert.equal(
    Date.parse(artifact.evidenceExpiresAt) - Date.parse(artifact.createdAt),
    30 * 86400000,
  );
});

test("artifact cleanup erases browser and offline inputs at 30 days without discarding outcomes", async () => {
  const path = await mkdtemp(join(tmpdir(), "evaluation-retention-"));
  try {
    await mkdir(join(path, "trials"));
    await mkdir(join(path, "imports"));
    await mkdir(join(path, "offline"));
    await writeFile(
      join(path, "offline", "a.request.json"),
      JSON.stringify({ input: "raw input" }),
    );
    await writeFile(
      join(path, "offline", "a.response.json"),
      JSON.stringify({ prepared: "raw prompt", result: "raw output" }),
    );
    const expected = { actions: [{ target: { candidateId: "c1" } }] };
    await writeFile(
      join(path, "manifest.json"),
      JSON.stringify({
        version: "1",
        id: "f403d014-b959-4752-8861-4d203448c592",
        createdAt: "2026-08-01T00:00:00Z",
        plan: { trials: [] },
        code: { revision: "test" },
        contentHash: "original-frozen-hash",
        cases: [
          {
            id: "offline",
            expected,
            input: { instruction: "Click Save", candidates: [{ id: "c1", text: "raw input" }] },
          },
        ],
      }),
    );
    await writeFile(
      join(path, "trials", "a.json"),
      JSON.stringify({
        result: { outcome: "found" },
        provider: [{ forwarded: true, reportedUsd: 0.001 }],
        evidence: { modelInput: "secret" },
        baseline: { result: { outcome: "not_found" }, evidence: { modelInput: "baseline secret" } },
        mutation: { fresh: { evidence: { modelInput: "secret" } } },
      }),
    );
    await writeFile(join(path, "trials", "a.json.partial"), '{"evidence":"interrupted raw input"');
    assert.equal(await prune(path, new Date("2026-08-30T00:00:00Z")), "retained");
    const retained = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
    assert.ok(retained.cases[0].input);
    assert.equal(await prune(path, new Date("2026-08-31T00:00:00Z")), "evidence_deleted");
    const expired = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
    assert.equal(expired.cases[0].input, undefined);
    assert.deepEqual(expired.cases[0].expected, expected);
    assert.equal(expired.evidenceAvailability, "expired");
    assert.equal(expired.contentHash, "original-frozen-hash");
    await assert.rejects(readFile(join(path, "offline", "a.request.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(path, "offline", "a.response.json")), { code: "ENOENT" });
    await assert.rejects(() => readFile(join(path, "trials", "a.json.partial")), {
      code: "ENOENT",
    });
    const trial = JSON.parse(await readFile(join(path, "trials", "a.json"), "utf8"));
    assert.equal(trial.evidence, null);
    assert.equal(trial.mutation.fresh.evidence, null);
    assert.equal(trial.baseline.evidence, null);
    assert.equal(trial.baseline.result.outcome, "not_found");
    assert.equal(trial.result.outcome, "found");
    assert.deepEqual(trial.provider, [{ forwarded: true, reportedUsd: 0.001 }]);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("context retention expires prepared requests and preflight evidence, then removes records", async () => {
  const path = await mkdtemp(join(tmpdir(), "context-retention-"));
  try {
    for (const sub of ["trials", "preflight", "provider"]) await mkdir(join(path, sub));
    const manifest = {
      version: 1,
      kind: "context-experiment",
      id: "context-run",
      createdAt: "2026-08-01T00:00:00Z",
      plan: [],
      code: { revision: "test" },
      preparedRequests: { a: [{ messages: [{ content: "private input" }] }] },
      contentHash: "original-frozen-hash",
    };
    await writeFile(join(path, "manifest.json"), JSON.stringify(manifest));
    for (const sub of ["trials", "preflight"])
      await writeFile(
        join(path, sub, "a.json"),
        JSON.stringify({
          result: { outcome: "found" },
          evidence: { modelInput: "private input" },
        }),
      );
    await writeFile(join(path, "provider", "a.json"), JSON.stringify({ request: "private input" }));
    assert.equal(await prune(path, new Date("2026-08-30T00:00:00Z")), "retained");
    assert.deepEqual(JSON.parse(await readFile(join(path, "manifest.json"), "utf8")), manifest);
    assert.equal(await prune(path, new Date("2026-08-31T00:00:00Z")), "evidence_deleted");
    const expired = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
    assert.equal(expired.preparedRequests, undefined);
    assert.equal(expired.evidenceAvailability, "expired");
    assert.equal(expired.contentHash, manifest.contentHash);
    for (const sub of ["trials", "preflight"]) {
      const trial = JSON.parse(await readFile(join(path, sub, "a.json"), "utf8"));
      assert.equal(trial.evidence, null);
      assert.equal(trial.evidenceAvailability, "expired");
      assert.equal(trial.result.outcome, "found");
    }
    await assert.rejects(readFile(join(path, "provider", "a.json")), { code: "ENOENT" });
    assert.equal(await prune(path, new Date("2026-10-30T00:00:00Z")), "records_deleted");
    await assert.rejects(readFile(join(path, "manifest.json")), { code: "ENOENT" });
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("current-view runs request scoped capture and reject a legacy-scope response", async (t) => {
  const { trial } = await runWithServices(t, "control-states-1-v4", {
    contractVersion: "4",
  });
  assert.match(trial.captureObservation.error.message, /wrong scope/);
  assert.equal(trial.error.code, "capture_scope_unverified");
});
