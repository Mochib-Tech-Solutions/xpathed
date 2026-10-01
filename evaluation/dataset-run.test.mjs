import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReconciledCharges,
  reserveCharge,
  makeCase,
  lexicalSelection,
  options,
  cli,
  profileEnvironment,
  retainProviderEvidence,
  validProviderCalls,
  finishProviderAttempt,
} from "./dataset-run.mjs";
import profiles from "./qualification-profiles.json" with { type: "json" };
import { gradeTrial } from "./grader.mjs";
import { prune } from "./run.mjs";

test("late accounting is validated after draining without rewriting the timed-out result", async () => {
  for (const knownCharge of [true, false]) {
    const upstream = Promise.withResolvers();
    const result = { outcome: "error", diagnostics: { code: "provider_timeout" } };
    const trial = { id: "attempt", result, elapsedMs: 123 };
    const record = { attemptId: trial.id, forwarded: true, reportedUsd: null };
    const proxy = {
      records: [record],
      budget: { pendingCharges: 1 },
      awaitIdle: () => upstream.promise,
    };
    const completed = finishProviderAttempt(trial, proxy, new Set());
    Object.assign(record, {
      identityValid: true,
      responseCacheHit: false,
      observedIdentity: { generationId: "late-generation" },
      reportedUsd: knownCharge ? 0.001 : null,
    });
    proxy.budget.pendingCharges = knownCharge ? 0 : 1;
    upstream.resolve();
    assert.equal(await completed, knownCharge);
    assert.equal(trial.result, result);
    assert.equal(trial.elapsedMs, 123);
    assert.equal(trial.provider[0].reportedUsd, knownCharge ? 0.001 : null);
    assert.equal(trial.error?.code, knownCharge ? undefined : "provider_evidence_invalid");
  }
  const trial = {
    id: "attempt",
    error: { code: "dataset_trial_error", message: "Original error" },
  };
  assert.equal(
    await finishProviderAttempt(
      trial,
      { records: [], budget: { pendingCharges: 0 }, awaitIdle: async () => {} },
      new Set(),
    ),
    false,
  );
  assert.deepEqual(trial.error, { code: "dataset_trial_error", message: "Original error" });
});

test("offline success requires exactly one forwarded call with fresh verified identity", () => {
  const call = { forwarded: true, identityValid: true, observedIdentity: { generationId: "g1" } };
  for (const calls of [
    [],
    [call, call],
    [{ ...call, forwarded: false }],
    [{ ...call, identityValid: undefined }],
    [{ ...call, observedIdentity: {} }],
    [{ ...call, responseCacheHit: true }],
  ])
    assert.equal(validProviderCalls(calls, new Set()), false);
  const generations = new Set();
  assert.equal(validProviderCalls([call], generations), true);
  assert.equal(validProviderCalls([call], generations), false);
});

test("offline provider payloads expire with evidence while identity and cost remain", async (t) => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "xpathed-offline-retention-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "trials"));
  await mkdir(join(directory, "provider"));
  const trial = { id: "attempt", evidence: null, error: { code: "dataset_trial_error" } };
  const record = {
    attemptId: trial.id,
    request: { private: "input" },
    response: { private: "output" },
    reportedUsd: 0.01,
    observedIdentity: { generationId: "g1" },
  };
  retainProviderEvidence(trial, [record]);
  assert.deepEqual(trial.evidence.provider, [record]);
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      version: "1",
      id: "run",
      plan: { trials: [{ id: trial.id }] },
      code: {},
      createdAt: "2026-08-01T00:00:00Z",
    }),
  );
  await writeFile(join(directory, "trials", "attempt.json"), JSON.stringify(trial));
  await writeFile(join(directory, "provider", "record.json"), JSON.stringify(record));
  assert.equal(await prune(directory, new Date("2026-09-01T00:00:00Z")), "evidence_deleted");
  const retained = JSON.parse(await readFile(join(directory, "trials", "attempt.json"), "utf8"));
  assert.equal(retained.evidence, null);
  assert.equal(retained.provider[0].reportedUsd, 0.01);
  assert.equal(retained.provider[0].observedIdentity.generationId, "g1");
  assert.equal(JSON.stringify(retained).includes("private"), false);
  await assert.rejects(readFile(join(directory, "provider", "record.json")), /ENOENT/);
});

test("offline profiles retain the DeepSeek default and accept only approved baseline settings", () => {
  const args = ["--import", "source", "--output", "output"];
  assert.equal(options(args).profile, "deepseek");
  assert.equal(options([...args, "--profile", "qwen"]).profile, "qwen");
  assert.equal(options([...args, "--profile", "gemini"]).profile, "gemini");
  for (const profile of ["unknown", "deepseek-concise"])
    assert.throws(() => options([...args, "--profile", profile]), /baseline profile/);
  assert.throws(() => options([...args, "--profile", "qwen", "--mode", "live"]), /reviewed-inputs/);
});

test("offline model settings match each baseline and clear inherited experimental settings", () => {
  for (const profile of profiles.filter((item) => item.variant === "baseline")) {
    const env = profileEnvironment(profile, "http://127.0.0.1:1234/api/v1/", {
      OpenRouter__ReasoningEffort: "high",
      OpenRouter__PromptCacheMode: "wrong",
      XPATHED_EVALUATION_PRICE_LIMITS: "untrusted",
    });
    assert.equal(env.OpenRouter__Model, profile.model);
    assert.equal(env.OpenRouter__Provider, profile.provider);
    assert.equal(env.OpenRouter__ReasoningEffort, profile.reasoning.effort);
    assert.equal(env.OpenRouter__PromptCacheMode, profile.promptCacheOptions?.mode);
    assert.equal(env.XPATHED_EVALUATION_PRICE_LIMITS, undefined);
    assert.equal(env.OpenRouter__ApiKey, "dataset-proxy-only");
  }
});

test("offline child execution leaves the local proxy responsive and preserves error evidence", async (t) => {
  const { createServer } = await import("node:http");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "xpathed-offline-cli-"));
  const server = createServer((_request, response) => {
    response.end(
      JSON.stringify({ outcome: "error", diagnostics: { code: "provider_malformed_response" } }),
    );
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeFile(
    join(directory, "dotnet"),
    `#!${process.execPath}\nfetch(process.env.TEST_PROXY).then(r => r.text()).then(text => { console.log(text); process.exitCode = 1; });\n`,
    { mode: 0o755 },
  );
  const result = await cli("input.json", {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    TEST_PROXY: `http://127.0.0.1:${server.address().port}`,
  });
  assert.equal(result.outcome, "error");
  assert.equal(result.diagnostics.code, "provider_malformed_response");
});

test("the shared spending ceiling includes reservations and refuses the next unaffordable call", () => {
  const ledger = {
    ceilingUsd: 5,
    entries: [
      { reservedUsd: 1, reportedUsd: null },
      { reservedUsd: 3, reportedUsd: 2 },
    ],
  };
  assert.equal(reserveCharge(ledger, 1.5, "attempt"), 1.5);
  assert.equal(ledger.entries.length, 3);
  assert.throws(() => reserveCharge(ledger, 0.6, "next"), /budget/i);
  assert.equal(ledger.entries.length, 3);
  assert.throws(() => reserveCharge(ledger, NaN, "invalid"), /charge/i);
});

test("both live runners block unknown and excessive retained charges until reconciliation", () => {
  for (const reportedUsd of [null, undefined, 0.011]) {
    assert.throws(
      () => assertReconciledCharges({ entries: [{ reservedUsd: 0.01, reportedUsd }] }),
      /Unreconciled prior attempt/,
    );
  }
  assert.doesNotThrow(() => assertReconciledCharges({ entries: [] }));
  for (const reportedUsd of [0, 0.005, 0.01])
    assert.doesNotThrow(() =>
      assertReconciledCharges({ entries: [{ reservedUsd: 0.01, reportedUsd }] }),
    );
});

test("source-only labels measure target identity without inventing annotated actions or browser state", () => {
  const spec = makeCase({
    id: "page-1",
    dataset: "phrasenode",
    split: "train",
    family: "page",
    instruction: "The Save button",
    inputKey: "abc",
    oracle: { candidateId: "n2" },
    provenance: { revision: "source" },
  });
  const selection = lexicalSelection({
    instruction: spec.instruction,
    candidates: [
      { id: "n1", tag: "button", label: "Cancel" },
      { id: "n2", tag: "button", label: "Save" },
    ],
  });
  assert.equal(selection.actions[0].candidateId, "n2");
  assert.equal(spec.expected.actions[0].action, undefined);
  const grade = gradeTrial(spec, {
    result: {
      contractVersion: "offline-1",
      outcome: "found",
      action: "inspect",
      actions: [
        {
          actionId: "a1",
          order: 1,
          step: 1,
          action: "inspect",
          outcome: "found",
          target: { candidateId: "n2" },
        },
      ],
    },
  });
  assert.equal(grade.passed, true);
  assert.equal(grade.metrics.actionsExpected, 0);
  assert.equal(grade.metrics.readinessExpected, 0);
});

test("dataset CLI preserves train-only selection, exact input integrity and replayable reports", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { spawnSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "xpathed-dataset-run-"));
  try {
    const imported = join(root, "import");
    await mkdir(join(imported, "inputs"), { recursive: true });
    const text = JSON.stringify({ candidates: [{ id: "n1", tag: "button", text: "Save" }] }) + "\n";
    const key = createHash("sha256").update(text).digest("hex");
    await writeFile(join(imported, "inputs", `${key}.json`), text);
    const item = {
      id: "train-save",
      status: "offline-eligible",
      dataset: "phrasenode",
      split: "train",
      family: "train-page",
      instruction: "Save",
      inputKey: key,
      oracle: { candidateId: "n1" },
      provenance: { revision: "fixture" },
    };
    for (const [file, data] of Object.entries({
      "cases.json": [item, { ...item, id: "test-save", split: "test", family: "test-page" }],
      "inventory.json": { imported: 2 },
      "manifest.json": { version: 1, revision: "fixture" },
    }))
      await writeFile(join(imported, file), JSON.stringify(data));
    const sha = (value) => createHash("sha256").update(value).digest("hex");
    await writeFile(
      join(imported, "manifest.json"),
      JSON.stringify({
        version: 1,
        revision: "fixture",
        casesSha256: sha(await readFile(join(imported, "cases.json"))),
        inventorySha256: sha(await readFile(join(imported, "inventory.json"))),
      }),
    );
    const output = join(root, "run");
    const run = (...args) =>
      spawnSync(process.execPath, ["evaluation/dataset-run.mjs", ...args], { encoding: "utf8" });
    const result = run("--import", imported, "--output", output);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const manifest = JSON.parse(await readFile(join(output, "manifest.json")));
    assert.deepEqual(
      manifest.cases.map((item) => item.id),
      ["train-save"],
    );
    const summary = JSON.parse(await readFile(join(output, "summary.json")));
    const replayed = run("--replay", output);
    assert.equal(replayed.status, 0, replayed.stderr);
    assert.deepEqual(JSON.parse(replayed.stdout), summary);
    assert.equal(summary.modelQualityMeasured, false);
    assert.equal(summary.firstAttempt.metrics.actionAccuracy, null);
    await writeFile(join(imported, "inputs", `${key}.json`), text.trimEnd());
    const tampered = join(root, "tampered");
    assert.equal(run("--import", imported, "--output", tampered).status, 1);
    const bad = JSON.parse(await readFile(join(tampered, "summary.json")));
    assert.equal(bad.firstAttempt.metrics.operationalError, 1);
    assert.equal(bad.completedTrials, 1);
    assert.equal(bad.firstAttempt.metrics.targetsCorrect, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
