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
  datasetProfiles,
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

test("prompt variants require explicit live mode and clear inherited offline settings", () => {
  const args = [
    "--import",
    "source",
    "--output",
    "output",
    "--mode",
    "live",
    "--reviewed-inputs",
    "reviews",
  ];
  assert.equal(options(args).promptVariant, "baseline");
  assert.equal(
    options([...args, "--prompt-variant", "intent-cardinality"]).promptVariant,
    "intent-cardinality",
  );
  for (const variant of ["concise", "declarative-inspect"])
    assert.throws(() => options([...args, "--prompt-variant", variant]), /prompt variant/);
  assert.throws(
    () =>
      options([
        "--import",
        "source",
        "--output",
        "output",
        "--prompt-variant",
        "intent-cardinality",
      ]),
    /live mode/,
  );
  const profile = profiles.find((item) => item.id === "qwen");
  const inherited = { XPATHED_EVALUATION_PROMPT_VARIANT: "intent-cardinality" };
  assert.equal(
    profileEnvironment(profile, "http://localhost/", inherited).XPATHED_EVALUATION_PROMPT_VARIANT,
    "baseline",
  );
  assert.equal(
    profileEnvironment(profile, "http://localhost/", inherited, "intent-cardinality")
      .XPATHED_EVALUATION_PROMPT_VARIANT,
    "intent-cardinality",
  );
});

test("offline profiles retain the DeepSeek default and accept only approved baseline settings", () => {
  const args = ["--import", "source", "--output", "output"];
  assert.equal(options(args).profile, "deepseek");
  assert.equal(options([...args, "--profile", "qwen"]).profile, "qwen");
  assert.equal(options([...args, "--profile", "gemini"]).profile, "gemini");
  assert.equal(options([...args, "--profile", "deepseek-deepinfra"]).profile, "deepseek-deepinfra");
  for (const profile of ["unknown", "deepseek-concise", "deepseek-deepinfra-fast"])
    assert.throws(() => options([...args, "--profile", profile]), /baseline profile/);
  assert.throws(() => options([...args, "--profile", "qwen", "--mode", "live"]), /reviewed-inputs/);
});

test("Azure Luna is an explicit offline route with unchanged no-reasoning and cache controls", () => {
  const args = ["--import", "imported", "--output", "results", "--profile", "luna-azure"];
  assert.equal(options(args).profile, "luna-azure");
  const original = profiles.find((profile) => profile.id === "luna");
  const alternate = datasetProfiles.find((profile) => profile.id === "luna-azure");
  assert.deepEqual(alternate, { ...original, id: "luna-azure", provider: "azure" });
  assert.equal(
    profiles.some((profile) => profile.id === "luna-azure"),
    false,
  );
  assert.equal(datasetProfiles.find((profile) => profile.id === "luna").provider, "openai");
  const env = profileEnvironment(alternate, "http://127.0.0.1:1234/api/v1/", {});
  assert.equal(env.OpenRouter__Provider, "azure");
  assert.equal(env.OpenRouter__ReasoningEffort, "none");
  assert.equal(env.OpenRouter__PromptCacheMode, "explicit");
});

test("DeepInfra is an explicit offline route and leaves the default and qualification profiles intact", () => {
  const baseline = profiles.find((profile) => profile.id === "deepseek");
  const alternate = datasetProfiles.find((profile) => profile.id === "deepseek-deepinfra");
  assert.deepEqual(alternate, {
    ...baseline,
    id: "deepseek-deepinfra",
    provider: "deepinfra/fp8",
  });
  assert.equal(baseline.provider, "wafer");
  assert.equal(
    profiles.some((profile) => profile.id === alternate.id),
    false,
  );
  const env = profileEnvironment(alternate, "http://127.0.0.1:1234/api/v1/", {});
  assert.equal(env.OpenRouter__Model, "deepseek/deepseek-v4.1-flash");
  assert.equal(env.OpenRouter__Provider, "deepinfra/fp8");
  assert.equal(env.OpenRouter__ReasoningEffort, undefined);
  assert.equal(env.XPATHED_EVALUATION_PROMPT_VARIANT, "baseline");
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

test("dataset runs default to the authorized campaign ceiling and permit only lower overrides", () => {
  const args = ["--import", "imported", "--output", "results"];
  assert.equal(options(args).budgetUsd, 10);
  assert.equal(options([...args, "--budget-usd", "5"]).budgetUsd, 5);
  assert.throws(() => options([...args, "--budget-usd", "10.01"]), /at most \$10/);
  const ledger = {
    ceilingUsd: 10,
    entries: [{ id: "retained", reservedUsd: 3, reportedUsd: 2 }],
  };
  reserveCharge(ledger, 8, "remaining");
  assert.throws(() => reserveCharge(ledger, 0.01, "too-much"), /budget/);
  assert.equal(ledger.entries.length, 2);
});

test("reservation reviews must consume the full maximum with an explicit reason and ISO timestamp", () => {
  const entry = {
    reservedUsd: 0.01,
    reportedUsd: null,
    reservationReview: {
      reason: "Explicit resume approval",
      reviewedAt: "2026-10-01T12:00:00.000Z",
      chargedUsd: 0.01,
    },
  };
  assert.doesNotThrow(() => assertReconciledCharges({ entries: [entry] }));
  for (const changed of [
    { chargedUsd: 0.009 },
    { chargedUsd: 0.011 },
    { chargedUsd: "0.01" },
    { reason: "" },
    { reason: "  " },
    { reviewedAt: "yesterday" },
    { reviewedAt: "2026-10-01" },
  ])
    assert.throws(
      () =>
        assertReconciledCharges({
          entries: [{ ...entry, reservationReview: { ...entry.reservationReview, ...changed } }],
        }),
      /Unreconciled/,
    );
  assert.throws(
    () => assertReconciledCharges({ entries: [{ ...entry, reportedUsd: 0.02 }] }),
    /Unreconciled/,
  );
  assert.throws(
    () => assertReconciledCharges({ entries: [entry, { reservedUsd: 0.01, reportedUsd: null }] }),
    /Unreconciled/,
  );
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

test("live dataset plans bind the selected inputs and prepared requests before forwarding", async (t) => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { spawnSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "xpathed-prepared-dataset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const input = { instruction: "Save", candidates: [{ id: "n1", tag: "button", text: "Save" }] };
  const inputText = JSON.stringify({ candidates: input.candidates });
  const inputKey = sha(inputText);
  const model = "deepseek/deepseek-v4.1-flash";
  const request = {
    model,
    messages: [
      { role: "system", content: "Select the target" },
      { role: "user", content: "Save: n1" },
    ],
    stream: false,
    max_tokens: 4096,
    reasoning: { enabled: false },
    response_format: {
      type: "json_schema",
      json_schema: { name: "result", strict: true, schema: {} },
    },
    provider: {
      only: ["wafer"],
      order: ["wafer"],
      allow_fallbacks: false,
      require_parameters: true,
    },
  };
  const prepared = {
    modelInput: "Save: n1",
    prompt: "Select the target",
    schema: {},
    promptVersion: "7",
    configurationId: "fixture",
    effective: {
      strategy: "fixture",
      request: {
        ...request,
        messages: [request.messages[0], { role: "user", content: "placeholder" }],
      },
    },
  };
  const item = {
    id: "save",
    status: "offline-eligible",
    dataset: "phrasenode",
    split: "train",
    family: "page",
    instruction: "Save",
    inputKey,
    oracle: { candidateId: "n1" },
    provenance: { revision: "fixture" },
  };
  const imported = join(root, "import");
  await mkdir(join(imported, "inputs"), { recursive: true });
  await writeFile(join(imported, "inputs", `${inputKey}.json`), inputText);
  const cases = JSON.stringify([item]);
  await writeFile(join(imported, "cases.json"), cases);
  await writeFile(join(imported, "inventory.json"), "{}");
  await writeFile(
    join(imported, "manifest.json"),
    JSON.stringify({ casesSha256: sha(cases), inventorySha256: sha("{}") }),
  );
  const review = {
    version: 1,
    entries: [
      {
        caseId: "save",
        inputHash: sha(JSON.stringify(input)),
        reviewer: "fixture",
        reviewedAt: "2026-10-01T00:00:00Z",
        providerSubmission: true,
      },
    ],
  };
  await writeFile(join(root, "reviews.json"), JSON.stringify(review));
  await writeFile(join(root, "prepared.json"), JSON.stringify(prepared));
  await writeFile(join(root, "request.json"), JSON.stringify(request));
  await writeFile(
    join(root, "dotnet"),
    `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('build')) process.exit(0);
if (process.argv.includes('--prepare-only')) console.log(fs.readFileSync('prepared.json', 'utf8'));
else fetch(process.env.OpenRouter__BaseUrl + 'chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: fs.readFileSync('request.json', 'utf8') }).then(() => console.log(JSON.stringify({outcome:'error', diagnostics:{code:'fixture_response'}})));
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(root, "network.mjs"),
    String.raw`
import { appendFile } from 'node:fs/promises';
const original = globalThis.fetch;
globalThis.fetch = async (url, options) => {
 if (String(url).startsWith('http://127.0.0.1:')) return original(url, options);
 if (String(url).endsWith('/endpoints')) return Response.json({data:{endpoints:[{tag:'wafer',provider_name:'Wafer',pricing:{prompt:'0.0000001',completion:'0.0000005'},supported_parameters:['response_format','structured_outputs','reasoning','max_tokens']}]}});
 if (String(url).endsWith('/chat/completions')) { await appendFile('forwarded.jsonl', options.body+'\n'); return Response.json({id:'generation-fixture',model:'${model}',provider:'Wafer',usage:{cost:0.001},choices:[]}); }
 throw new Error('Unexpected network request');
};
`,
  );
  const entry = {
    caseId: "save",
    inputHash: sha(JSON.stringify(input)),
    requestSha256: sha(JSON.stringify(request)),
    maximumUsd: 0.1,
  };
  const plan = { version: 1, profileId: "deepseek", promptVariant: "baseline", entries: [entry] };
  const run = async (name, changed, preparedValue = prepared, requestValue = request) => {
    await rm(join(root, "forwarded.jsonl"), { force: true });
    await writeFile(join(root, "plan.json"), JSON.stringify(changed));
    await writeFile(join(root, "prepared.json"), JSON.stringify(preparedValue));
    await writeFile(join(root, "request.json"), JSON.stringify(requestValue));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        join(root, "network.mjs"),
        resolve("evaluation/dataset-run.mjs"),
        "--import",
        imported,
        "--output",
        join(root, name),
        "--mode",
        "live",
        "--reviewed-inputs",
        join(root, "reviews.json"),
        "--prepared-plan",
        join(root, "plan.json"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          OPENROUTER_EVAL_API_KEY: "fixture-only",
          XPATHED_BUDGET_GITHUB_REPOSITORY: "",
          GH_TOKEN: "",
          XPATHED_WORKSPACE: root,
        },
      },
    );
    const forwarded = await readFile(join(root, "forwarded.jsonl"), "utf8").catch(() => "");
    return { result, forwarded };
  };
  const valid = await run("valid", plan);
  assert.ok(valid.forwarded.includes(model), valid.result.stderr + valid.result.stdout);
  const failures = [
    null,
    { ...plan, version: 2 },
    { ...plan, profileId: "qwen" },
    { ...plan, promptVariant: "intent-cardinality" },
    { ...plan, entries: [] },
    { ...plan, entries: [entry, entry] },
    ...[
      { caseId: "other" },
      { inputHash: "a".repeat(64) },
      { requestSha256: "b".repeat(64) },
      { maximumUsd: 0 },
      { maximumUsd: "0.1" },
      { maximumUsd: null },
      { requestSha256: "bad" },
      { maximumUsd: 0.00000001 },
    ].map((change) => ({ ...plan, entries: [{ ...entry, ...change }] })),
  ];
  for (const [i, invalid] of failures.entries()) {
    const { result, forwarded } = await run(`invalid-${i}`, invalid);
    assert.notEqual(result.status, 0, `Invalid plan ${i} accepted`);
    assert.equal(forwarded, "", `Invalid plan ${i} forwarded`);
  }
  for (const [name, changed] of [
    ["changed-input", { ...prepared, modelInput: "Stop: n1" }],
    [
      "changed-model",
      {
        ...prepared,
        effective: {
          ...prepared.effective,
          request: { ...prepared.effective.request, model: "another/model" },
        },
      },
    ],
    [
      "changed-prompt",
      {
        ...prepared,
        effective: {
          ...prepared.effective,
          request: {
            ...prepared.effective.request,
            messages: [
              { role: "system", content: "Different prompt" },
              prepared.effective.request.messages[1],
            ],
          },
        },
      },
    ],
  ]) {
    const { forwarded } = await run(name, plan, changed);
    assert.equal(forwarded, "", `${name} forwarded`);
  }
  const actualMutation = await run("actual-request-change", plan, prepared, {
    ...request,
    messages: [request.messages[0], { role: "user", content: "Stop: n1" }],
  });
  assert.equal(actualMutation.forwarded, "", "Actual request must match its prepared request");
});
