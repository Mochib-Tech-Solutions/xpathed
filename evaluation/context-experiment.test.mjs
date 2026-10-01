import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextPlan, summarizeContext } from "./context-experiment.mjs";
import { createFixtureServer } from "./server.mjs";

test("context comparison pairs each current-view case once, alternating arm order", () => {
  const cases = [
    { id: "first", contractVersion: "4" },
    { id: "second", contractVersion: "4" },
  ];
  assert.deepEqual(
    buildContextPlan(cases).map(({ caseId, arm }) => [caseId, arm]),
    [
      ["first", "control"],
      ["first", "jev"],
      ["second", "jev"],
      ["second", "control"],
    ],
  );
  assert.throws(() => buildContextPlan([...cases, cases[0]]), /duplicate/i);
  assert.throws(() => buildContextPlan([{ id: "old", contractVersion: "3" }]), /current.view/i);
});

test("context statistics retain missing/failed attempts and unknown classifier cost", () => {
  const plan = buildContextPlan([
    { id: "a", contractVersion: "4" },
    { id: "b", contractVersion: "4" },
  ]);
  const trials = [
    {
      ...plan[0],
      grade: { passed: true },
      elapsedMs: 800,
      result: { diagnostics: { modelInputBytes: 1000, modelInputComplete: true } },
      provider: [{ forwarded: true, reportedUsd: 0.01 }],
    },
    {
      ...plan[1],
      grade: { passed: false },
      elapsedMs: 1800,
      result: { diagnostics: { modelInputBytes: 500, modelInputComplete: true } },
      provider: [
        { forwarded: true, reportedUsd: 0.005 },
        { forwarded: true, reportedUsd: null },
      ],
    },
  ];
  const result = summarizeContext(plan, trials);
  assert.equal(result.arms.control.planned, 2);
  assert.equal(result.arms.control.correct, 1);
  assert.equal(result.arms.jev.missing, 1);
  assert.equal(result.arms.jev.correct, 0);
  assert.equal(result.arms.jev.reportedUsd, null);
  assert.equal(result.arms.jev.knownReportedUsd, 0.005);
  assert.equal(result.pairs[0].inputBytesReduction, 500);
  assert.equal(result.pairs[0].bothCorrect, false);
  assert.equal(result.pairs[0].elapsedMsReduction, null);
  assert.equal(result.pairs[0].observedElapsedMsDelta, -1000);
  assert.equal(result.pairs[1].complete, false);
  assert.equal(result.qualified, false);
  assert.throws(() => summarizeContext(plan, [...trials, trials[0]]), /duplicate/i);
});

test("context projection preserves original serialized core and only removes optional evidence", async () => {
  const { projectContextRequest } = await import("./context-experiment.mjs");
  const core =
    '{"instruction":"Click A\\u0026B","scope":"current_view","frameId":"main","evidenceAvailability":{"appearance":"included","geometry":"included"},"candidates":[{"id":"c1","label":"A\\u0026B","state":{},"geometry":{"x":1,"y":2},"appearance":{"backgroundColor":"rgb(1, 2, 3)"},"frame":{"id":"main","labels":[]}}]}';
  const request = {
    model: "fixed",
    messages: [
      { role: "system", content: "fixed core" },
      { role: "user", content: core },
    ],
  };
  const projected = projectContextRequest(request, false, false);
  assert.equal(projected.messages[0].content, "fixed core");
  assert.ok(projected.messages[1].content.includes("A\\u0026B"));
  const input = JSON.parse(projected.messages[1].content);
  assert.deepEqual(input.candidates, [
    { id: "c1", label: "A&B", state: {}, frame: { id: "main", labels: [] } },
  ]);
  assert.deepEqual(input.evidenceAvailability, {
    appearance: "not_requested",
    geometry: "not_requested",
  });
  assert.equal(request.messages[1].content, core);
  assert.equal(projectContextRequest(request, true, true).messages[1].content, core);
});

test("context main rejects unknown options without starting services", async () => {
  const { main } = await import("./context-experiment.mjs");
  await assert.rejects(main(["--retry", "2"]), /Unknown context option/);
});

test("slow correct responses remain correct while missing the latency target", () => {
  const plan = buildContextPlan([{ id: "slow", contractVersion: "4" }]);
  const trials = plan.map((trial) => ({ ...trial, elapsedMs: 2500, grade: { passed: true } }));
  const summary = summarizeContext(plan, trials);
  for (const arm of Object.values(summary.arms)) {
    assert.equal(arm.correct, 1);
    assert.equal(arm.correctWithinTwoSeconds, 0);
    assert.equal(arm.latencyMs.p50, 2500);
  }
  assert.deepEqual(summary.measurementErrors, []);
  assert.equal(summary.pairs[0].bothCorrect, true);
});

test("context summary distinguishes setup failures from timed provider failures", () => {
  const plan = buildContextPlan([{ id: "a", contractVersion: "4" }]);
  const trials = plan.map((p) => ({
    ...p,
    mode: "live",
    elapsedMs: 2001,
    grade: { passed: false },
    error: { code: "resolution_timeout" },
  }));
  assert.deepEqual(summarizeContext(plan, trials).measurementErrors, []);
  delete trials[1].elapsedMs;
  trials[1].error.code = "http_400";
  const summary = summarizeContext(plan, trials);
  assert.equal(summary.measurementErrors.length, 1);
  assert.match(summary.measurementErrors[0], /resolution did not start/i);
  assert.equal(summary.arms.jev.completed, 1);
  assert.equal(summary.arms.jev.correct, 0);
  assert.equal(summary.pairs[0].elapsedMsReduction, null);
});

test("context preflight and live plans both register once at the actual fixture boundary", async () => {
  const { buildContextPreflightPlan } = await import("./context-experiment.mjs");
  const cases = [{ id: "same-reviewed-case", contractVersion: "4" }];
  const plan = buildContextPlan(cases);
  const preflight = buildContextPreflightPlan(plan);
  const server = createFixtureServer({ cases });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const register = (trial) =>
    fetch(`http://127.0.0.1:${server.address().port}/trial`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: trial.id, caseId: trial.caseId }),
    });
  try {
    for (const trial of [...preflight, ...plan]) assert.equal((await register(trial)).status, 200);
    assert.equal((await register(plan[0])).status, 400);
    assert.deepEqual(
      preflight.map((p) => p.liveAttemptId),
      plan.map((p) => p.id),
    );
    assert.deepEqual(
      preflight.map((p) => [p.caseId, p.arm]),
      plan.map((p) => [p.caseId, p.arm]),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("context summary rejects fresh-pair claims for repeated or missing successful generation identities", () => {
  const plan = buildContextPlan([{ id: "a", contractVersion: "4" }]);
  const trials = plan.map((p) => ({
    ...p,
    mode: "live",
    elapsedMs: 500,
    grade: { passed: true },
    provider: [
      {
        forwarded: true,
        identityValid: true,
        observedIdentity: {
          model: "deepseek/deepseek-v4.1-flash",
          provider: "DeepInfra",
          generationId: p.id,
          serviceTier: null,
        },
      },
    ],
  }));
  assert.equal(summarizeContext(plan, trials).freshness.valid, true);
  trials[1].provider[0].observedIdentity.generationId =
    trials[0].provider[0].observedIdentity.generationId;
  const repeated = summarizeContext(plan, trials);
  assert.equal(repeated.freshness.valid, false);
  assert.match(repeated.freshness.errors.join(" "), /repeated generation/i);
  assert.equal(repeated.pairs[0].elapsedMsReduction, null);
  delete trials[1].provider[0].observedIdentity.generationId;
  assert.match(summarizeContext(plan, trials).freshness.errors.join(" "), /missing generation/i);
  trials[1].grade.passed = false;
  trials[1].provider[0].identityValid = false;
  const failed = summarizeContext(plan, trials);
  assert.equal(failed.freshness.unverifiedCalls, 1);
  assert.equal(failed.arms.jev.correct, 0);
});

test("context core comparison uses the frozen request when diagnostic input is withheld", async () => {
  const { verifyContextCore } = await import("./context-experiment.mjs");
  const trial = (assisted, id = "c1") => ({
    evidence: {
      modelInput: null,
      availability: "withheld_sensitive_instruction",
      systemPrompt: assisted ? "core policy" : "core",
      outputSchema: "schema",
      preparedProviderRequest: {
        messages: [
          { role: "system", content: assisted ? "core policy" : "core" },
          {
            role: "user",
            content: JSON.stringify({
              instruction: "Fill Notes.",
              scope: "current_view",
              candidates: [{ id, label: "Notes", geometry: { x: 1 } }],
              ...(assisted
                ? { evidenceAvailability: { geometry: "included", appearance: "included" } }
                : {}),
            }),
          },
        ],
      },
    },
  });
  verifyContextCore(trial(false), trial(true));
  assert.throws(
    () => verifyContextCore(trial(false), trial(true, "other")),
    /core candidate inventory/,
  );
});

test("context runner preserves every failed attempt and replay rejects changed evidence", async (t) => {
  const { main } = await import("./context-experiment.mjs");
  const output = await mkdtemp(join(tmpdir(), "context-runner-"));
  const server = createServer((_req, response) => {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Fixture unavailable" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const oldFixture = process.env.XPATHED_FIXTURE_URL,
    oldPort = process.env.XPATHED_CONTEXT_PROXY_PORT;
  process.env.XPATHED_FIXTURE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.XPATHED_CONTEXT_PROXY_PORT = "0";
  t.mock.method(console, "log", () => {});
  try {
    assert.equal(await main(["--output", output]), 1);
    const manifest = JSON.parse(await readFile(join(output, "manifest.json")));
    const summary = JSON.parse(await readFile(join(output, "summary.json")));
    assert.equal(manifest.plan.length, 32);
    assert.equal(summary.arms.control.completed, 16);
    assert.equal(summary.arms.jev.completed, 16);
    assert.equal(summary.arms.control.correct + summary.arms.jev.correct, 0);
    assert.equal(await main(["--replay", output]), 1);
    const path = join(output, "trials", `${manifest.plan[0].id}.json`);
    const trial = JSON.parse(await readFile(path));
    trial.elapsedMs = 1;
    await writeFile(path, JSON.stringify(trial));
    await assert.rejects(main(["--replay", output]), /evidence changed/);
  } finally {
    if (oldFixture === undefined) delete process.env.XPATHED_FIXTURE_URL;
    else process.env.XPATHED_FIXTURE_URL = oldFixture;
    if (oldPort === undefined) delete process.env.XPATHED_CONTEXT_PROXY_PORT;
    else process.env.XPATHED_CONTEXT_PROXY_PORT = oldPort;
    await new Promise((resolve) => server.close(resolve));
    await rm(output, { recursive: true, force: true });
  }
});
