import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createBudgetProxy, contextPlanningQuestions } from "./provider.mjs";

const model = "deepseek/deepseek-v4.1-flash";
const pricing = {
  data: {
    endpoints: [
      {
        tag: "wafer",
        provider_name: "Wafer",
        pricing: { prompt: "0.0000001", completion: "0.0000005" },
      },
    ],
  },
};
const input = { model, messages: [{ role: "user", content: "Find Save" }], max_tokens: 4096 };

test("provider-limit tracking preserves historical unknown charges and does not gate spending", async (t) => {
  const prior = { id: "prior", reservedUsd: 11, reportedUsd: null };
  const { proxy, post, calls, ledgerPath } = await setup(t, {
    budgetPolicy: "provider-limit",
    initial: { version: 1, budgetPolicy: "provider-limit", ceilingUsd: 10, entries: [prior] },
    completion: () => Response.json({ id: "tracking", model, provider: "Wafer", choices: [] }),
  });
  await proxy.awaitIdle();
  proxy.beginAttempt("one", "default", 0.0000001, input);
  assert.equal((await post()).status, 200);
  assert.equal(proxy.records[0].reportedUsd, null);
  assert.equal(proxy.records[0].error, undefined);
  assert.equal(proxy.budget.remainingUsd, null);
  assert.equal(proxy.budget.ceilingUsd, null);
  assert.equal(proxy.budget.unknownChargeRecords, 2);
  assert.equal(Object.hasOwn(JSON.parse(calls[0].options.body).provider, "max_price"), false);
  assert.deepEqual(JSON.parse(await readFile(ledgerPath, "utf8")).entries[0], prior);
  assert.throws(() => proxy.beginAttempt("one"), /repeated/);
  await proxy.awaitIdle();
  proxy.beginAttempt("two");
  assert.equal((await post()).status, 200);
  assert.equal(calls.length, 2);
});

test("context planning pre-registers both calls and defers accounting until the timed response finishes", async (t) => {
  const { contextPlanningQuestions } = await import("./provider.mjs");
  const decisionRequest = {
    model: "typesafe/jev-1.13",
    state: "Find Save",
    questions: contextPlanningQuestions,
    provider: { only: ["typesafe"], order: ["typesafe"], allow_fallbacks: false },
  };
  const request = {
    ...input,
    messages: [
      { role: "user", content: JSON.stringify({ instruction: "Find Save", candidates: [] }) },
    ],
  };
  const { proxy, post, base, calls, ledgerPath } = await setup(t, {
    contextPlanning: true,
    budgetPolicy: "provider-limit",
    metadata: (url) =>
      url.includes("typesafe")
        ? {
            data: {
              endpoints: [
                {
                  tag: "typesafe",
                  provider_name: "TypeSafe",
                  status: 0,
                  name: "TypeSafe | typesafe/jev-1.13-20260917",
                  pricing: { prompt: "0.000000042", completion: "0" },
                },
              ],
            },
          }
        : pricing,
    completion: (url) =>
      url.endsWith("/decisions")
        ? Response.json({
            id: "gen-dec-test",
            model: "typesafe/jev-1.13-20260917",
            provider: "TypeSafe",
            answers: {
              appearance: { type: "noul", noul: 0.01 },
              layout: { type: "noul", noul: 0.99 },
            },
            usage: { input_tokens: 200, output_tokens: 20, cost: 0.00001 },
          })
        : Response.json({ id: "chat-test", model, provider: "Wafer", usage: { cost: 0.001 } }),
  });
  await proxy.reserveAttempt("planned", "default", 0.01, {
    preparedRequests: [request],
    decisionRequest,
  });
  assert.equal(JSON.parse(await readFile(ledgerPath, "utf8")).entries.length, 2);
  const decide = () =>
    fetch(new URL("/api/alpha/decisions", base), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(decisionRequest),
    });
  assert.equal((await decide()).status, 200);
  assert.equal((await decide()).status, 409);
  assert.equal((await post(request)).status, 200);
  assert.equal(
    JSON.parse(await readFile(ledgerPath, "utf8")).entries.every((e) => e.reportedUsd === null),
    true,
  );
  await proxy.finishAttempt();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://openrouter.ai/api/alpha/decisions");
  assert.deepEqual(proxy.records.map((r) => r.kind).sort(), ["chat", "decision"]);
  assert.equal(
    proxy.records.every((r) => r.attemptId === "planned"),
    true,
  );
  assert.equal(proxy.budget.knownReportedUsd, 0.00101);
  assert.equal(proxy.records.find((r) => r.kind === "decision").usage.input_tokens, 200);
});

test("tracking accepts unavailable pricing and reports unavailable estimates without dropping request guards", async (t) => {
  const metadata = structuredClone(pricing);
  delete metadata.data.endpoints[0].pricing;
  const { proxy, post, calls, ledgerPath } = await setup(t, {
    budgetPolicy: "provider-limit",
    metadata,
    completion: () => Response.json({ id: "unpriced", model, provider: "Wafer" }),
  });
  const forecast = proxy.forecastRequests([
    { id: "unpriced", profileId: "default", request: input },
  ]);
  assert.equal(forecast.projectedUsd, null);
  assert.equal(forecast.remainingUsd, null);
  assert.equal(forecast.fits, null);
  await proxy.awaitIdle();
  proxy.beginAttempt("unpriced", "default", null, input);
  assert.equal((await post()).status, 200);
  assert.equal(proxy.budget.knownReportedUsd, 0);
  assert.equal(proxy.budget.unknownEstimateRecords, 1);
  assert.equal(proxy.budget.spentUsd, null);
  assert.equal(proxy.budget.pendingCharges, 1);
  assert.equal(JSON.parse(await readFile(ledgerPath, "utf8")).entries[0].reservedUsd, null);
  await proxy.awaitIdle();
  proxy.beginAttempt("changed", "default", null, input);
  assert.equal(
    (await post({ ...input, messages: [{ role: "user", content: "Changed" }] })).status,
    400,
  );
  assert.equal(calls.length, 1);
});

test("tracking records charges above estimates and still rejects unknown routes and premium serving", async (t) => {
  const { proxy, post, calls } = await setup(t, {
    budgetPolicy: "provider-limit",
    completion: () =>
      Response.json({ id: "expensive", model, provider: "Wafer", usage: { cost: 20 } }),
  });
  await proxy.awaitIdle();
  proxy.beginAttempt("priced");
  assert.equal((await post()).status, 200);
  assert.equal(proxy.budget.knownReportedUsd, 20);
  assert.equal(proxy.budget.pendingCharges, 0);
  for (const [i, changed] of [
    { model: "other" },
    { service_tier: "priority" },
    { max_tokens: 4097 },
    { provider: { only: ["other"] } },
  ].entries()) {
    await proxy.awaitIdle();
    proxy.beginAttempt(`invalid-${i}`);
    assert.equal((await post({ ...input, ...changed })).status, 400);
  }
  assert.equal(calls.length, 1);
});

test("body timeout recovers its header-identified charge without inventing a successful response", async (t) => {
  const { proxy, post, calls, ledgerPath } = await setup(t, {
    completion: (url) => {
      if (url.endsWith("/generation?id=gen-timeout"))
        return Response.json({
          data: { id: "gen-timeout", model, provider_name: "Wafer", total_cost: 0.001 },
        });
      return {
        status: 200,
        headers: new Headers({ "X-Generation-Id": "gen-timeout" }),
        text: async () => {
          throw new Error("Response body timed out");
        },
      };
    },
  });
  await proxy.awaitIdle();
  proxy.beginAttempt("timeout");
  const response = await post();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /Response body timed out/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, "GET");
  const record = proxy.records[0];
  assert.equal(record.headers["x-generation-id"], "gen-timeout");
  assert.equal(record.reportedUsd, 0.001);
  assert.equal(record.reportedCostSource, "generation");
  assert.equal(record.response, null);
  assert.equal(record.identityValid, undefined);
  assert.equal(record.observedIdentity, undefined);
  assert.equal(proxy.budget.pendingCharges, 0);
  assert.equal(JSON.parse(await readFile(ledgerPath, "utf8")).entries[0].reportedUsd, 0.001);
  assert.throws(() => proxy.beginAttempt("next"), /blocked/);
});

test("unverified timeout accounting retains its full reservation without retrying inference", async (t) => {
  for (const [name, header, recovery] of [
    ["missing header", false, null],
    ["unavailable lookup", true, () => Response.json({}, { status: 404 })],
    [
      "different generation",
      true,
      () => Response.json({ data: { id: "other", model, provider_name: "Wafer", total_cost: 0 } }),
    ],
    [
      "different provider",
      true,
      () =>
        Response.json({
          data: { id: "gen-timeout", model, provider_name: "Other", total_cost: 0 },
        }),
    ],
    [
      "missing charge",
      true,
      () => Response.json({ data: { id: "gen-timeout", model, provider_name: "Wafer" } }),
    ],
    [
      "excessive charge",
      true,
      () =>
        Response.json({
          data: { id: "gen-timeout", model, provider_name: "Wafer", total_cost: 99 },
        }),
    ],
  ])
    await t.test(name, async (t) => {
      const { proxy, post, calls } = await setup(t, {
        completion: (url) =>
          url.includes("/generation?")
            ? recovery()
            : {
                status: 200,
                headers: new Headers(header ? { "X-Generation-Id": "gen-timeout" } : {}),
                text: async () => {
                  throw new Error("Body timeout");
                },
              },
      });
      await proxy.awaitIdle();
      proxy.beginAttempt("timeout");
      assert.equal((await post()).status, 502);
      assert.equal(calls.filter((c) => c.url.endsWith("/chat/completions")).length, 1);
      assert.equal(calls.length, header ? 2 : 1);
      const recovered = name === "excessive charge" ? 99 : null;
      assert.equal(proxy.records[0].reportedUsd, recovered);
      assert.equal(proxy.budget.pendingCharges, recovered === null ? 1 : 0);
      assert.equal(proxy.budget.spentUsd, recovered ?? proxy.records[0].reservedUsd);
      assert.throws(() => proxy.beginAttempt("next"), /blocked/);
    });
});

test("frozen request rejects changed content before reserving or forwarding", async (t) => {
  const { proxy, post, calls } = await setup(t);
  const maximum = proxy.forecastRequests([{ id: "frozen", profileId: "default", request: input }])
    .reservations[0].maximumUsd;
  await proxy.awaitIdle();
  proxy.beginAttempt("frozen", "default", maximum, input);
  const response = await post({ ...input, messages: [{ role: "user", content: "Find Edit" }] });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /frozen prepared request/);
  assert.equal(calls.length, 0);
  assert.equal(proxy.budget.spentUsd, 0);
  assert.equal(proxy.budget.pendingCharges, 0);
});

test("frozen request accepts equivalent key order and cannot be changed by its caller", async (t) => {
  const { proxy, post, calls } = await setup(t);
  const prepared = structuredClone(input);
  await proxy.awaitIdle();
  proxy.beginAttempt("frozen", "default", 0.01, prepared);
  prepared.messages[0].content = "Find Edit";
  const response = await post({
    max_tokens: input.max_tokens,
    messages: [{ content: "Find Save", role: "user" }],
    model,
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].options.body).messages[0].content, "Find Save");
});

async function setup(
  t,
  {
    completion,
    ceilingUsd,
    initial,
    onRecord,
    profiles,
    metadata = pricing,
    github,
    contextPlanning,
    budgetPolicy = "provider-limit",
    apiKey = "test-provider-secret",
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "xpathed-comparison-budget-"));
  let proxy;
  t.after(async () => {
    await proxy?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const ledgerPath = join(directory, "experiment-budget.json");
  if (initial) await writeFile(ledgerPath, JSON.stringify(initial));
  const calls = [];
  const fetchImpl = async (url, options) => {
    if (url.startsWith("https://api.github.com/")) return github.fetch(url, options);
    if (url.endsWith("/endpoints"))
      return Response.json(typeof metadata === "function" ? metadata(url) : metadata);
    calls.push({ url, options });
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.equal(
      ledger.entries.at(-1).reportedUsd,
      null,
      "persist a reservation before the paid request",
    );
    assert.ok(
      ledger.entries.at(-1).reservedUsd > 0 ||
        (ledger.budgetPolicy === "provider-limit" && ledger.entries.at(-1).reservedUsd === null),
    );
    return completion
      ? completion(url, options)
      : Response.json({
          id: "generation-1",
          usage: { cost: 0.001, prompt_tokens: 50, completion_tokens: 20 },
          choices: [],
        });
  };
  proxy = await createBudgetProxy({
    apiKey,
    ledgerPath,
    fetchImpl,
    ceilingUsd,
    onRecord,
    profiles,
    contextPlanning,
    budgetPolicy,
    githubRepository: github ? "Example/Private" : "",
    githubToken: github ? "test-github-secret" : "",
  });
  proxy.server.listen(0, "127.0.0.1");
  await once(proxy.server, "listening");
  const base = `http://127.0.0.1:${proxy.server.address().port}/api/v1`;
  const post = (body = input, signal) =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { proxy, post, base, calls, ledgerPath, fetchImpl };
}

async function contextFixture(t, options = {}) {
  const decisionRequest = {
    model: "typesafe/jev-1.13",
    state: "Find Save",
    questions: contextPlanningQuestions,
    provider: { only: ["typesafe"], order: ["typesafe"], allow_fallbacks: false },
  };
  const request = {
    ...input,
    messages: [
      { role: "user", content: JSON.stringify({ instruction: "Find Save", candidates: [] }) },
    ],
  };
  const fixture = await setup(t, {
    contextPlanning: true,
    budgetPolicy: "provider-limit",
    metadata: (url) =>
      url.includes("typesafe")
        ? {
            data: {
              endpoints: [
                {
                  tag: "typesafe",
                  provider_name: "TypeSafe",
                  status: 0,
                  pricing: { prompt: "0.000000042", completion: "0" },
                },
              ],
            },
          }
        : pricing,
    ...options,
  });
  return {
    ...fixture,
    decisionRequest,
    request,
    decide: (body = decisionRequest, signal) =>
      fetch(new URL("/api/alpha/decisions", fixture.base), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
  };
}

test("context decisions are opt-in and cannot change the frozen instruction or questions", async (t) => {
  const disabled = await setup(t);
  assert.equal(
    (await fetch(new URL("/api/alpha/decisions", disabled.base), { method: "POST" })).status,
    404,
  );
  const { proxy, request, decisionRequest, decide, calls, post } = await contextFixture(t);
  for (const changed of [
    { ...decisionRequest, state: "Send unrelated data" },
    {
      ...decisionRequest,
      questions: { ...decisionRequest.questions, extra: { type: "noul", instructions: "Other" } },
    },
    { ...decisionRequest, provider: { only: ["other"] } },
  ])
    await assert.rejects(
      proxy.reserveAttempt("invalid", "default", null, {
        preparedRequests: [request],
        decisionRequest: changed,
      }),
      /frozen|original/,
    );
  assert.equal(proxy.records.length, 0);
  await proxy.reserveAttempt("changed-wire", "default", null, {
    preparedRequests: [request],
    decisionRequest,
  });
  assert.equal((await post(request)).status, 409);
  assert.equal((await decide({ ...decisionRequest, state: "Changed" })).status, 502);
  assert.equal(calls.length, 0);
  await proxy.finishAttempt();
  assert.equal(
    proxy.records.every((record) => record.forwarded === false && record.reportedUsd === null),
    true,
  );
  assert.equal(
    proxy.records.every((record) => record.accountingStatus === "not_forwarded"),
    true,
  );
  assert.equal(proxy.budget.notForwardedRecords, 2);
  assert.equal(proxy.budget.unknownChargeRecords, 0);
  assert.equal(proxy.budget.pendingCharges, 0);
  assert.equal(proxy.budget.spentUsd, 0);
  await proxy.reserveAttempt("control", "default", null, { preparedRequests: [request] });
  assert.equal((await decide()).status, 409);
  assert.equal((await post(request)).status, 200);
  await proxy.finishAttempt();
  assert.equal(calls.length, 1);
});

test("capture failure settles unused context slots without inventing provider costs", async (t) => {
  const { proxy, request, decisionRequest, calls, ledgerPath } = await contextFixture(t);
  await proxy.reserveAttempt("capture-failed", "default", null, {
    preparedRequests: [request],
    decisionRequest,
  });
  assert.equal(proxy.budget.unknownChargeRecords, 2);
  await proxy.finishAttempt();
  const entries = JSON.parse(await readFile(ledgerPath, "utf8")).entries;
  assert.equal(calls.length, 0);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(entry.accountingStatus, "not_forwarded");
    assert.equal(entry.reportedUsd, null);
  }
  assert.equal(proxy.budget.unknownChargeRecords, 0);
  assert.equal(proxy.budget.pendingCharges, 0);
  assert.equal(proxy.budget.notForwardedRecords, 2);
  assert.equal(proxy.budget.spentUsd, 0);
});

test("a cancelled classifier does not block the one chat call and settlement waits for late evidence", async (t) => {
  const started = Promise.withResolvers(),
    upstream = Promise.withResolvers();
  const { proxy, request, decisionRequest, decide, post, calls } = await contextFixture(t, {
    completion: (url) => {
      if (url.endsWith("/decisions")) {
        started.resolve();
        return upstream.promise;
      }
      return Response.json({ id: "chat", model, provider: "Wafer", usage: { cost: 0.001 } });
    },
  });
  await proxy.reserveAttempt("slow", "default", null, {
    preparedRequests: [request],
    decisionRequest,
  });
  const controller = new AbortController();
  const pending = decide(decisionRequest, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal((await post(request)).status, 200);
  let settled = false;
  const settlement = proxy.finishAttempt().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  upstream.resolve(
    Response.json({
      model: "typesafe/jev-1.13-20260917",
      provider: "TypeSafe",
      id: "gen-dec-late",
      answers: { appearance: { type: "noul", noul: 0.1 }, layout: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 100, output_tokens: 10 },
    }),
  );
  await settlement;
  assert.equal(calls.length, 2);
  assert.equal(proxy.records.find((record) => record.kind === "decision").reportedUsd, null);
  assert.equal(proxy.records.find((record) => record.kind === "decision").decisionValid, true);
  await proxy.awaitIdle();
  proxy.beginAttempt("next");
});

test("a cached or wrong-provider decision forces fallback while retaining its real charge", async (t) => {
  for (const kind of ["cache", "identity"])
    await t.test(kind, async (t) => {
      const { proxy, request, decisionRequest, decide, post } = await contextFixture(t, {
        completion: (url) =>
          url.endsWith("/decisions")
            ? Response.json(
                {
                  id: "gen-dec-rejected",
                  model: "typesafe/jev-1.13",
                  provider: kind === "identity" ? "Other" : "TypeSafe",
                  answers: {
                    appearance: { type: "noul", noul: 0 },
                    layout: { type: "noul", noul: 0 },
                  },
                  usage: { cost: 0.00001 },
                },
                { headers: kind === "cache" ? { "x-openrouter-cache-status": "HIT" } : {} },
              )
            : Response.json({ model, provider: "Wafer", id: "chat", usage: { cost: 0.001 } }),
      });
      await proxy.reserveAttempt(kind, "default", null, {
        preparedRequests: [request],
        decisionRequest,
      });
      const response = await decide();
      assert.equal(response.status, 502);
      assert.equal((await response.json()).answers, undefined);
      assert.equal((await post(request)).status, 200);
      await proxy.finishAttempt();
      const record = proxy.records.find((record) => record.kind === "decision");
      assert.equal(record.decisionValid, false);
      assert.equal(record.reportedUsd, 0.00001);
    });
});

test("live evaluation selects its dedicated key and never falls back to the app key in a file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "xpathed-evaluation-key-"));
  const names = ["OPENROUTER_EVAL_API_KEY", "OPENROUTER_API_KEY", "XPATHED_ENV_FILE"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(async () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(directory, { recursive: true, force: true });
  });
  process.env.XPATHED_ENV_FILE = join(directory, ".env");
  for (const [name, environment, file, expected] of [
    [
      "dedicated environment wins",
      { OPENROUTER_EVAL_API_KEY: "eval-env", OPENROUTER_API_KEY: "app-env" },
      "OPENROUTER_EVAL_API_KEY=eval-file\nOPENROUTER_API_KEY=app-file\n",
      "eval-env",
    ],
    [
      "dedicated file wins over legacy environment",
      { OPENROUTER_API_KEY: "legacy-env" },
      "OPENROUTER_EVAL_API_KEY = 'eval-file' # dedicated\nOPENROUTER_API_KEY=app-file\n",
      "eval-file",
    ],
    [
      "application key cannot fund evaluations",
      { OPENROUTER_API_KEY: "legacy-env" },
      "OPENROUTER_API_KEY=app-file\n",
      null,
    ],
    ["app-only file is refused", {}, "OPENROUTER_API_KEY=app-file\n", null],
    [
      "blank dedicated key does not select the app file key",
      {},
      "OPENROUTER_EVAL_API_KEY=\nOPENROUTER_API_KEY=app-file\n",
      null,
    ],
  ]) {
    await t.test(name, async (t) => {
      delete process.env.OPENROUTER_EVAL_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      Object.assign(process.env, environment);
      await writeFile(process.env.XPATHED_ENV_FILE, file);
      if (expected === null) {
        await assert.rejects(setup(t, { apiKey: null }), /Set OPENROUTER_EVAL_API_KEY/);
        return;
      }
      const { proxy, post, calls } = await setup(t, { apiKey: null });
      await proxy.awaitIdle();
      proxy.beginAttempt("configured-key");
      assert.equal((await post()).status, 200);
      assert.equal(calls[0].options.headers.Authorization, `Bearer ${expected}`);
    });
  }
});

function githubBudget(initial) {
  let ledger = structuredClone(initial);
  const authority = "github:example/private:evaluation-budget:experiment-budget.json";
  return {
    get ledger() {
      return structuredClone(ledger);
    },
    async fetch(url, options) {
      assert.equal(options.headers.Authorization, "Bearer test-github-secret");
      assert.equal(new URL(url).pathname, "/repos/example/private/contents/experiment-budget.json");
      const sha = () =>
        createHash("sha1")
          .update(JSON.stringify(ledger, null, 2) + "\n")
          .digest("hex");
      if (options.method === "GET") {
        assert.equal(new URL(url).searchParams.get("ref"), "evaluation-budget");
        return Response.json({
          type: "file",
          encoding: "base64",
          sha: sha(),
          content: Buffer.from(JSON.stringify(ledger)).toString("base64"),
        });
      }
      assert.equal(options.method, "PUT");
      const body = JSON.parse(options.body);
      assert.equal(body.branch, "evaluation-budget");
      if (body.sha !== sha()) return Response.json({}, { status: 409 });
      ledger = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
      assert.equal(ledger.remoteAuthority, authority);
      return Response.json({ content: { sha: sha() } });
    },
  };
}

test("prepared baseline reserves before the timed request and returns before remote reconciliation", async (t) => {
  const github = githubBudget({
    version: 1,
    ceilingUsd: 5,
    remoteAuthority: "github:example/private:evaluation-budget:experiment-budget.json",
    entries: [],
  });
  const { proxy, post, calls } = await setup(t, { github });
  const maximum = proxy.forecastRequests([{ id: "prepared", profileId: "default", request: input }])
    .reservations[0].maximumUsd;
  await proxy.reserveAttempt("prepared", "default", maximum);
  assert.equal(calls.length, 0);
  assert.equal(github.ledger.entries[0].reservedUsd, maximum);
  const reconcile = Promise.withResolvers();
  const originalFetch = github.fetch;
  github.fetch = async (url, options) => {
    if (options.method === "PUT") await reconcile.promise;
    return originalFetch(url, options);
  };
  try {
    const response = await post(input, AbortSignal.timeout(1000));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).usage.cost, 0.001);
    assert.equal(github.ledger.entries[0].reportedUsd, null);
    assert.throws(() => proxy.beginAttempt("overlap"), /overlapping/);
  } finally {
    reconcile.resolve();
    await proxy.finishAttempt();
  }
  assert.equal(github.ledger.entries[0].reportedUsd, 0.001);
  assert.equal(calls.length, 1);
  assert.ok(proxy.records[0].elapsedMs >= proxy.records[0].responseElapsedMs);
});

test("a pre-reserved ordinary request binds the exact prepared payload before forwarding", async (t) => {
  const { proxy, post, calls } = await setup(t);
  await proxy.reserveAttempt("bound", "default", 0.01, { preparedRequest: input });
  const changed = structuredClone(input);
  changed.messages = [{ role: "user", content: "Different instruction" }];
  assert.equal((await post(changed)).status, 502);
  assert.equal(calls.length, 0);
  await assert.rejects(proxy.finishAttempt(), /evidence or inference/);
});

test("a fresh hosted proxy preserves authoritative historical spend and durably reserves before inference", async (t) => {
  const previous = { id: "historical", reservedUsd: 2, reportedUsd: 1.5 };
  const github = githubBudget({
    version: 1,
    ceilingUsd: 5,
    remoteAuthority: "github:example/private:evaluation-budget:experiment-budget.json",
    entries: [previous],
  });
  const { proxy, post, ledgerPath } = await setup(t, {
    github,
    completion: () => {
      assert.deepEqual(github.ledger.entries[0], previous);
      assert.equal(github.ledger.entries.length, 2);
      assert.equal(github.ledger.entries[1].reportedUsd, null);
      return Response.json({ usage: { cost: 0.001 } });
    },
  });
  assert.equal(proxy.budget.spentUsd, 1.5);
  await proxy.awaitIdle();
  proxy.beginAttempt("hosted-attempt");
  assert.equal((await post()).status, 200);
  await proxy.awaitIdle();
  assert.equal(github.ledger.entries[1].reportedUsd, 0.001);
  assert.deepEqual(JSON.parse(await readFile(ledgerPath, "utf8")), github.ledger);
  for (const stage of ["reservation", "reconciliation"]) {
    const duration = proxy.records[0].remoteAccountingMs[stage];
    assert.ok(Number.isFinite(duration) && duration >= 0);
  }
});

test("metadata outage warnings never expose credentials and do not block startup", async (t) => {
  const { proxy } = await setup(t, {
    github: githubBudget({ version: 1, entries: [] }),
    metadata: () => {
      throw new Error("test-provider-secret test-github-secret unavailable");
    },
  });
  assert.match(proxy.profiles[0].metadataWarning, /unavailable/);
  assert.doesNotMatch(JSON.stringify(proxy.profiles), /test-provider-secret|test-github-secret/);
});

test("shutdown retains late provider accounting after the caller disconnects", async (t) => {
  for (const outcome of ["reply", "failure"])
    await t.test(outcome, async (t) => {
      const started = Promise.withResolvers();
      const upstream = Promise.withResolvers();
      const retained = [];
      const { proxy, post, ledgerPath, fetchImpl } = await setup(t, {
        completion: () => {
          started.resolve();
          return upstream.promise;
        },
        onRecord: async (record) => retained.push(record),
      });
      const connection = once(proxy.server, "connection");
      const controller = new AbortController();
      await proxy.awaitIdle();
      proxy.beginAttempt("disconnected");
      const request = post(input, controller.signal);
      const [socket] = await connection;
      const disconnected = once(socket, "close");
      await started.promise;
      controller.abort();
      await assert.rejects(request, /abort/i);
      await disconnected;
      const serverClosed = once(proxy.server, "close");
      let firstClosed = false;
      let secondClosed = false;
      let drained = false;
      const draining = proxy.awaitIdle().then(() => (drained = true));
      const first = proxy.close().then(() => (firstClosed = true));
      const second = proxy.close().then(() => (secondClosed = true));
      try {
        await serverClosed;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(firstClosed, false, "closing the HTTP server must not abandon inference");
        assert.equal(secondClosed, false, "every close caller must await accounting");
        assert.equal(drained, false, "evidence snapshots must wait for upstream accounting");
        await access(`${ledgerPath}.lock`);
        assert.equal(proxy.budget.pendingCharges, 1);
        if (outcome === "reply")
          upstream.resolve(
            Response.json({
              id: "late-generation",
              model,
              provider: "Wafer",
              usage: { cost: 0.001, prompt_tokens: 50, completion_tokens: 20 },
              choices: [],
            }),
          );
        else upstream.reject(new Error("Upstream timed out"));
        await Promise.all([first, second, draining]);
        await assert.rejects(access(`${ledgerPath}.lock`), /ENOENT/);
        const entry = JSON.parse(await readFile(ledgerPath, "utf8")).entries[0];
        assert.equal(entry.reportedUsd, outcome === "reply" ? 0.001 : null);
        assert.equal(retained.at(-1).reportedUsd, entry.reportedUsd);
        assert.equal(retained.at(-1).forwarded, true);
        if (outcome === "failure") {
          assert.match(retained.at(-1).error, /Upstream timed out/);
          const reopened = await createBudgetProxy({ apiKey: "key", ledgerPath, fetchImpl });
          assert.equal(reopened.budget.pendingCharges, 1);
          await reopened.close();
        }
      } finally {
        upstream.resolve(Response.json({ usage: { cost: 0.001 }, choices: [] }));
        await Promise.all([first, second]);
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
});

test("proxy reserves before payment, pins the effective route, accounts actual cost and refuses retries", async (t) => {
  const retained = [];
  const { proxy, post, calls, ledgerPath, base } = await setup(t, {
    onRecord: async (record) => retained.push(record),
  });
  assert.equal((await post()).status, 409);
  await proxy.awaitIdle();
  proxy.beginAttempt("case:custom");
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 409);
  assert.throws(() => proxy.beginAttempt("case:custom"), /repeated/);
  assert.equal(calls.length, 1);
  const effective = JSON.parse(calls[0].options.body);
  assert.deepEqual(effective.reasoning, { enabled: false });
  assert.deepEqual(effective.provider, {
    only: ["wafer"],
    order: ["wafer"],
    allow_fallbacks: false,
    require_parameters: true,
  });
  assert.equal(effective.max_tokens, 4096);
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-provider-secret");
  await proxy.awaitIdle();
  assert.equal(retained[0].reportedUsd, null);
  assert.equal(retained.at(-1).reportedUsd, 0.001);
  assert.equal(proxy.records[0].usage.prompt_tokens, 50);
  assert.ok(proxy.records[0].elapsedMs >= 0);
  assert.ok(!JSON.stringify(proxy.records).includes("test-provider-secret"));
  assert.equal(JSON.parse(await readFile(ledgerPath, "utf8")).entries[0].reportedUsd, 0.001);
  assert.deepEqual(await (await fetch(`${base}/models/${model}/endpoints`)).json(), pricing);
  await proxy.awaitIdle();
  proxy.beginAttempt("case:stagehand");
  assert.equal((await post()).status, 200);
  assert.equal(calls.length, 2);
});

test("invalid or unbounded inference requests fail before any provider charge", async (t) => {
  const { proxy, post, calls } = await setup(t);
  const invalid = [
    "{broken",
    { ...input, model: "another/model" },
    { ...input, stream: true },
    { ...input, max_tokens: 4097 },
    { ...input, n: 2 },
    { ...input, reasoning: { enabled: true } },
    { ...input, provider: { only: ["another"] } },
    { ...input, provider: { allow_fallbacks: true } },
    { ...input, plugins: [{ id: "web" }] },
    { ...input, service_tier: "batch" },
    { ...input, messages: [{ role: "user", content: "hello", audio: { id: "audio" } }] },
    {
      ...input,
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }],
        },
      ],
    },
  ];
  for (const [index, body] of invalid.entries()) {
    await proxy.awaitIdle();
    proxy.beginAttempt(`invalid:${index}`);
    assert.equal((await post(body)).status, 400);
  }
  assert.equal(calls.length, 0);
  assert.equal(proxy.records.length, invalid.length);
});

test("failure to retain the reservation evidence prevents payment and keeps the shared ledger blocked", async (t) => {
  const { proxy, post, calls, ledgerPath } = await setup(t, {
    onRecord: async () => {
      throw new Error("artifact storage failed");
    },
  });
  await proxy.awaitIdle();
  proxy.beginAttempt("storage-failure");
  assert.equal((await post()).status, 502);
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(await readFile(ledgerPath, "utf8")).entries[0].reportedUsd, null);
  assert.throws(() => proxy.beginAttempt("next"), /blocked/);
});

test("simultaneous SDK calls cannot create another paid request", async (t) => {
  let release, started;
  const pending = new Promise((resolve) => {
    started = resolve;
  });
  const { proxy, post, calls } = await setup(t, {
    completion: () =>
      new Promise((resolve) => {
        release = () => resolve(Response.json({ usage: { cost: 0 } }));
        started();
      }),
  });
  await proxy.awaitIdle();
  proxy.beginAttempt("single-inference");
  const first = post();
  await pending;
  try {
    assert.equal((await post()).status, 409);
    assert.throws(() => proxy.beginAttempt("overlap"), /overlapping/);
    assert.equal(calls.length, 1);
  } finally {
    release();
  }
  assert.equal((await first).status, 200);
});

const qualificationProfiles = [
  {
    id: "luna",
    model: "openai/gpt-6-luna",
    provider: "openai",
    reasoning: { effort: "none" },
    maxTokens: 1024,
    promptCacheOptions: { mode: "explicit" },
  },
  {
    id: "gemini",
    model: "google/gemini-3.8-flash",
    provider: "google-ai-studio",
    reasoning: { effort: "low" },
    maxTokens: 1024,
  },
  { id: "flash", model, provider: "wafer", reasoning: { enabled: false }, maxTokens: 1024 },
  {
    id: "qwen",
    model: "qwen/qwen3.8-flash",
    provider: "alibaba",
    reasoning: { enabled: false },
    maxTokens: 4096,
  },
];
const profileMetadata = (url) => {
  const profile = qualificationProfiles.find((item) => url.includes(item.model));
  return {
    data: {
      endpoints: [
        {
          tag: profile.provider,
          status: 0,
          supported_parameters: [
            "response_format",
            "structured_outputs",
            "reasoning",
            "max_tokens",
          ],
          pricing: {
            prompt: "0.0000001",
            completion: "0.0000005",
            input_cache_write: "0.000000125",
            overrides: [
              {
                min_prompt_tokens: 272000,
                prompt: "0.0000002",
                completion: "0.00000075",
                input_cache_write: "0.00000025",
              },
            ],
          },
        },
      ],
    },
  };
};
const profileInput = (profile) => ({
  ...input,
  model: profile.model,
  max_tokens: profile.maxTokens,
  reasoning: profile.reasoning,
  ...(profile.promptCacheOptions ? { prompt_cache_options: profile.promptCacheOptions } : {}),
  provider: {
    only: [profile.provider],
    order: [profile.provider],
    allow_fallbacks: false,
    require_parameters: true,
  },
  response_format: {
    type: "json_schema",
    json_schema: { name: "selection", strict: true, schema: { type: "object" } },
  },
});

const azureProfile = { ...qualificationProfiles[0], id: "luna-azure", provider: "azure" };
const azureMetadata = () => {
  const metadata = profileMetadata(`/models/${azureProfile.model}/endpoints`);
  const endpoint = metadata.data.endpoints[0];
  endpoint.tag = "azure";
  endpoint.provider_name = "Azure";
  endpoint.supported_parameters = endpoint.supported_parameters.map((parameter) =>
    parameter === "max_tokens" ? "max_completion_tokens" : parameter,
  );
  return metadata;
};

test("Azure Luna forwards the frozen output cap using its advertised completion parameter", async (t) => {
  const { proxy, post, calls } = await setup(t, {
    profiles: [azureProfile],
    metadata: azureMetadata(),
    completion: () =>
      Response.json({
        model: azureProfile.model,
        provider: "Azure",
        id: "azure-generation",
        usage: { cost: 0.001 },
      }),
  });
  const request = profileInput(azureProfile);
  const forecast = proxy.forecastRequests([{ id: "azure", profileId: azureProfile.id, request }]);
  assert.equal(forecast.fits, null);
  assert.ok(Number.isFinite(forecast.projectedUsd));
  assert.ok(forecast.projectedUsd > 1024 * 0.00000075);
  await proxy.awaitIdle();
  proxy.beginAttempt("azure", azureProfile.id, forecast.projectedUsd, request);
  assert.equal((await post(request)).status, 200);
  assert.equal(calls.length, 1);
  const forwarded = JSON.parse(calls[0].options.body);
  assert.equal(forwarded.max_completion_tokens, 1024);
  assert.equal(Object.hasOwn(forwarded, "max_tokens"), false);
  assert.deepEqual(forwarded.provider.only, ["azure"]);
  assert.deepEqual(forwarded.reasoning, { effort: "none" });
  assert.deepEqual(forwarded.prompt_cache_options, { mode: "explicit" });
  assert.equal(proxy.records[0].identityValid, true);
  assert.ok(Number.isFinite(proxy.records[0].reservedUsd));
});

test("Azure Luna rejects conflicting output aliases before reserving or forwarding", async (t) => {
  const { proxy, post, calls } = await setup(t, {
    profiles: [azureProfile],
    metadata: azureMetadata(),
  });
  const request = { ...profileInput(azureProfile), max_completion_tokens: 512 };
  assert.throws(
    () => proxy.forecastRequests([{ id: "conflict", profileId: azureProfile.id, request }]),
    /Output limit/,
  );
  await proxy.awaitIdle();
  proxy.beginAttempt("conflict", azureProfile.id);
  assert.equal((await post(request)).status, 400);
  assert.equal(calls.length, 0);
  assert.equal(proxy.budget.spentUsd, 0);
});

test("the Azure profile ID cannot authorize a different model or lose explicit cache controls", async (t) => {
  for (const profile of [
    {
      ...azureProfile,
      model,
      provider: "wafer",
      reasoning: { enabled: false },
      promptCacheOptions: undefined,
    },
    { ...azureProfile, promptCacheOptions: undefined },
  ]) {
    const metadata = azureMetadata();
    metadata.data.endpoints[0].tag = profile.provider;
    await assert.rejects(setup(t, { profiles: [profile], metadata }), /Unapproved/);
  }
});

test("Azure alias normalization preserves frozen request and allocation guards", async (t) => {
  const { proxy, post, calls } = await setup(t, {
    profiles: [azureProfile],
    metadata: azureMetadata(),
    completion: () =>
      Response.json({
        model: azureProfile.model,
        provider: "Azure",
        id: "azure-alias",
        usage: { cost: 0.001 },
      }),
  });
  const request = profileInput(azureProfile);
  const alias = { ...request, max_completion_tokens: 1024 };
  delete alias.max_tokens;
  const forecast = (request) =>
    proxy.forecastRequests([{ id: "prepared", profileId: azureProfile.id, request }]).projectedUsd;
  assert.equal(forecast(request), forecast(alias));
  assert.equal(forecast(request), forecast({ ...request, max_completion_tokens: 1024 }));
  await proxy.awaitIdle();
  proxy.beginAttempt("changed", azureProfile.id, forecast(request), request);
  assert.equal(
    (await post({ ...alias, messages: [{ role: "user", content: "Find Help" }] })).status,
    400,
  );
  await proxy.awaitIdle();
  proxy.beginAttempt("underfunded", azureProfile.id, 0.00001, request);
  assert.equal((await post(alias)).status, 200);
  await proxy.awaitIdle();
  assert.equal(calls.length, 1);
  await proxy.awaitIdle();
  proxy.beginAttempt("equivalent", azureProfile.id, forecast(request), request);
  assert.equal((await post(alias)).status, 200);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].options.body).max_completion_tokens, 1024);
});

test("Azure requires its advertised cap and rejects route, tier, reasoning and cache drift", async (t) => {
  const metadata = azureMetadata();
  metadata.data.endpoints[0].supported_parameters = [
    "max_tokens",
    "reasoning",
    "response_format",
    "structured_outputs",
  ];
  await assert.rejects(setup(t, { profiles: [azureProfile], metadata }), /required parameters/);
  for (const profile of [
    { ...azureProfile, id: "luna" },
    { ...azureProfile, provider: "azure/eu" },
    { ...azureProfile, provider: "azure/priority" },
  ])
    await assert.rejects(
      setup(t, { profiles: [profile], metadata: azureMetadata() }),
      /Unapproved/,
    );
  const { proxy, post, calls } = await setup(t, {
    profiles: [azureProfile],
    metadata: azureMetadata(),
  });
  for (const [index, mutation] of [
    { provider: { only: ["azure/eu"] } },
    { service_tier: "priority" },
    { reasoning: { effort: "low" } },
    { prompt_cache_options: undefined },
    { prompt_cache_options: { mode: "automatic" } },
    { max_tokens: 1023 },
    { max_tokens: undefined, max_completion_tokens: 1023 },
    { max_tokens: undefined, max_completion_tokens: 4097 },
  ].entries()) {
    await proxy.awaitIdle();
    proxy.beginAttempt(`reject-${index}`, azureProfile.id);
    assert.equal((await post({ ...profileInput(azureProfile), ...mutation })).status, 400);
  }
  assert.equal(calls.length, 0);
  assert.equal(proxy.budget.spentUsd, 0);
});

test("the explicit offline DeepInfra profile pins only its approved standard endpoint", async (t) => {
  const profile = {
    id: "deepseek-deepinfra",
    model,
    provider: "deepinfra/fp8",
    reasoning: { enabled: false },
    maxTokens: 4096,
  };
  const metadata = {
    data: {
      endpoints: [
        {
          ...profileMetadata(`/models/${model}/endpoints`).data.endpoints[0],
          tag: "deepinfra/fp8",
          provider_name: "DeepInfra",
        },
      ],
    },
  };
  const { proxy, post, calls } = await setup(t, {
    profiles: [profile],
    metadata,
    completion: () =>
      Response.json({
        model,
        provider: "DeepInfra",
        id: "generation-deepinfra",
        usage: { cost: 0.001 },
      }),
  });
  for (const [index, mutation] of [
    { provider: { only: ["deepinfra/turbo"] } },
    { service_tier: "priority" },
    { reasoning: { enabled: true } },
  ].entries()) {
    await proxy.awaitIdle();
    proxy.beginAttempt(`rejected-${index}`, profile.id);
    assert.equal((await post({ ...profileInput(profile), ...mutation })).status, 400);
  }
  assert.equal(calls.length, 0);
  await proxy.awaitIdle();
  proxy.beginAttempt("standard", profile.id);
  assert.equal((await post(profileInput(profile))).status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body).provider.only, ["deepinfra/fp8"]);
  assert.equal(proxy.records.at(-1).identityValid, true);
  await assert.rejects(
    setup(t, { profiles: [{ ...profile, provider: "deepinfra/turbo" }] }),
    /Unapproved/,
  );
  await assert.rejects(
    setup(t, { profiles: [{ ...profile, id: "arbitrary-route" }] }),
    /Unapproved/,
  );
});

test("qualification pins each approved profile and reserves the highest tier and cache-write cost", async (t) => {
  const { proxy, post, calls, ledgerPath } = await setup(t, {
    profiles: qualificationProfiles,
    metadata: profileMetadata,
    completion: (_url, options) =>
      Response.json(
        {
          model: JSON.parse(options.body).model,
          provider: JSON.parse(options.body).provider.only[0],
          id: "generation",
          usage: { cost: 0.001, prompt_tokens_details: { cached_tokens: 12 } },
        },
        {
          headers: {
            "x-openrouter-cache-status": "MISS",
            "x-request-id": "request",
            "set-cookie": "private",
          },
        },
      ),
  });
  assert.throws(() => proxy.beginAttempt("unknown", "missing"), /Unknown/);
  for (const profile of qualificationProfiles) {
    await proxy.awaitIdle();
    proxy.beginAttempt(profile.id, profile.id);
    assert.equal((await post(profileInput(profile))).status, 200);
  }
  assert.equal(calls.length, 4);
  assert.equal(proxy.budget.knownReportedUsd, 0.004);
  assert.equal(proxy.budget.ceilingUsd, null);

  assert.equal(JSON.parse(await readFile(ledgerPath, "utf8")).entries.length, 4);
  for (const [index, call] of calls.entries()) {
    const profile = qualificationProfiles[index];
    const request = JSON.parse(call.options.body);
    assert.equal(request.model, profile.model);
    assert.deepEqual(request.reasoning, profile.reasoning);
    assert.deepEqual(request.provider.only, [profile.provider]);
    assert.equal(call.options.headers["X-OpenRouter-Cache"], "false");
    assert.equal(request.provider.max_price, undefined);
    const record = proxy.records[index];
    assert.ok(record.remoteAccountingMs.reservation >= 0);
    assert.equal(record.profileId, profile.id);
    assert.equal(record.observedIdentity.model, profile.model);
    assert.equal(record.identityValid, true);
    assert.equal(call.options.headers["X-OpenRouter-Metadata"], "enabled");
    assert.equal(record.headers["x-openrouter-cache-status"], "MISS");
    assert.equal(record.headers["set-cookie"], undefined);
    assert.equal(record.responseCacheHit, false);
    assert.equal(record.usage.prompt_tokens_details.cached_tokens, 12);
    assert.equal(record.pricing.prompt, 0.00000025);
  }
});

test("qualification refuses profile drift, implicit routing and non-strict output before payment", async (t) => {
  const profile = qualificationProfiles[0];
  const { proxy, post, calls } = await setup(t, {
    profiles: qualificationProfiles,
    metadata: profileMetadata,
  });
  const valid = profileInput(profile);
  const invalid = [
    { ...valid, model },
    { ...valid, reasoning: { effort: "high" } },
    { ...valid, reasoning: undefined },
    { ...valid, reasoning: { effort: "none", exclude: true } },
    { ...valid, provider: undefined },
    { ...valid, provider: { ...valid.provider, sort: "latency" } },
    { ...valid, provider: { ...valid.provider, require_parameters: false } },
    { ...valid, provider: { ...valid.provider, only: ["openai/fast"] } },
    { ...valid, max_tokens: 2048 },
    { ...valid, prompt_cache_options: undefined },
    { ...valid, response_format: { type: "json_object" } },
    { ...valid, service_tier: "priority" },
    { ...valid, temperature: 0 },
  ];
  for (const [index, request] of invalid.entries()) {
    await proxy.awaitIdle();
    proxy.beginAttempt(`invalid-profile-${index}`, profile.id);
    assert.equal((await post(request)).status, 400);
  }
  assert.equal(calls.length, 0);
});

test("Qwen refuses enabled reasoning or a different provider before payment", async (t) => {
  const profile = qualificationProfiles.find((item) => item.id === "qwen");
  const { proxy, post, calls } = await setup(t, {
    profiles: [profile],
    metadata: profileMetadata,
  });
  const valid = profileInput(profile);
  const invalid = [
    { ...valid, reasoning: { enabled: true } },
    { ...valid, provider: { ...valid.provider, only: ["alibaba/fast"] } },
  ];
  for (const [index, request] of invalid.entries()) {
    await proxy.awaitIdle();
    proxy.beginAttempt(`qwen-invalid-${index}`, profile.id);
    assert.equal((await post(request)).status, 400);
  }
  assert.equal(calls.length, 0);
});

test("cache hits remain explicit evidence despite unique generation IDs", async (t) => {
  const { proxy, post } = await setup(t, {
    completion: () =>
      Response.json(
        { id: "unique-id", usage: { cost: 0 } },
        { headers: { "x-openrouter-cache-status": "HIT" } },
      ),
  });
  await proxy.awaitIdle();
  proxy.beginAttempt("cached");
  assert.equal((await post()).status, 200);
  assert.equal(proxy.records[0].responseCacheHit, true);
  assert.equal(proxy.records[0].reportedUsd, 0);
});

test("qualification reconciles charged identity or cache failures but blocks subsequent calls", async (t) => {
  for (const reason of ["identity", "cache", "tier"])
    await t.test(reason, async (t) => {
      const profile = qualificationProfiles[0];
      const { proxy, post, ledgerPath } = await setup(t, {
        profiles: [profile],
        metadata: profileMetadata,
        completion: () =>
          Response.json(
            {
              model: reason === "identity" ? "other/model" : profile.model,
              provider: profile.provider,
              service_tier: reason === "tier" ? "priority" : "default",
              usage: { cost: 0.001 },
            },
            { headers: { "x-openrouter-cache-status": reason === "cache" ? "HIT" : "MISS" } },
          ),
      });
      await proxy.awaitIdle();
      proxy.beginAttempt("mismatch", profile.id);
      assert.equal((await post(profileInput(profile))).status, 200);
      assert.equal(proxy.records[0].identityValid, reason === "cache");
      assert.equal(proxy.records[0].responseCacheHit, reason === "cache");
      assert.equal(JSON.parse(await readFile(ledgerPath, "utf8")).entries[0].reportedUsd, 0.001);
      assert.throws(() => proxy.beginAttempt("next", profile.id), /blocked/);
    });
});

test("billing outages and estimates never gate a successful inference", async (t) => {
  for (const cost of [undefined, 500])
    await t.test(String(cost), async (t) => {
      const { proxy, post } = await setup(t, {
        metadata: { data: { endpoints: [] } },
        completion: () =>
          Response.json({
            id: "fresh",
            model,
            provider: "Wafer",
            usage: cost === undefined ? {} : { cost },
          }),
      });
      await proxy.awaitIdle();
      proxy.beginAttempt("first");
      assert.equal((await post()).status, 200);
      await proxy.awaitIdle();
      proxy.beginAttempt("second");
      assert.equal((await post()).status, 200);
      assert.equal(proxy.budget.ceilingUsd, null);
    });
});

test("ledger failures preserve evidence and never stop successive inference attempts", async (t) => {
  for (const failure of ["locked", "malformed", "unwritable", "remote-read", "remote-write"]) {
    await t.test(failure, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "xpathed-accounting-outage-"));
      const ledgerPath = join(directory, "ledger.json");
      const prior = {
        version: 1,
        entries: [{ id: "historical", reservedUsd: 0.1, reportedUsd: null }],
      };
      if (failure === "unwritable") await mkdir(ledgerPath);
      else await writeFile(ledgerPath, failure === "malformed" ? "{broken" : JSON.stringify(prior));
      if (failure === "locked") await mkdir(`${ledgerPath}.lock`);
      const remote = githubBudget({
        ...prior,
        remoteAuthority: "github:example/private:evaluation-budget:experiment-budget.json",
      });
      const retained = [];
      let calls = 0;
      const proxy = await createBudgetProxy({
        apiKey: "test-provider-secret",
        ledgerPath,
        githubRepository: failure.startsWith("remote-") ? "example/private" : "",
        githubToken: "test-github-secret",
        onRecord: async (record) => retained.push(record),
        fetchImpl: async (url, options) => {
          if (url.startsWith("https://api.github.com/")) {
            if (failure === "remote-read" || options.method === "PUT")
              return Response.json({}, { status: 503 });
            return remote.fetch(url, options);
          }
          if (url.endsWith("/endpoints")) return Response.json(pricing);
          calls++;
          return Response.json({
            id: `generation-${calls}`,
            model,
            provider: "Wafer",
            usage: { cost: calls === 1 ? 9 : null },
            choices: [],
          });
        },
      });
      t.after(async () => {
        await proxy.close();
        await rm(directory, { recursive: true, force: true });
      });
      proxy.server.listen(0, "127.0.0.1");
      await once(proxy.server, "listening");
      for (const id of ["one", "two"]) {
        proxy.beginAttempt(id);
        const response = await fetch(
          `http://127.0.0.1:${proxy.server.address().port}/chat/completions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          },
        );
        assert.equal(response.status, 200);
        await proxy.awaitIdle();
      }
      assert.equal(calls, 2);
      assert.equal(proxy.records[0].reportedUsd, 9);
      assert.equal(proxy.records[1].reportedUsd, null);
      assert.equal(retained.at(-1).attemptId, "two");
      assert.ok(proxy.accountingWarnings.length > 0);
      if (["locked", "malformed"].includes(failure))
        assert.equal(
          await readFile(ledgerPath, "utf8"),
          failure === "malformed" ? "{broken" : JSON.stringify(prior),
        );
    });
  }
});

test("unrepresentable pricing estimates remain unknown without blocking requests", async (t) => {
  const metadata = structuredClone(pricing);
  metadata.data.endpoints[0].pricing.prompt = "1e308";
  const { proxy, post } = await setup(t, { metadata });
  const forecast = proxy.forecastRequests([
    { id: "overflow", profileId: "default", request: input },
  ]);
  assert.equal(forecast.reservations[0].maximumUsd, null);
  proxy.beginAttempt("overflow");
  assert.equal((await post()).status, 200);
  await proxy.awaitIdle();
  assert.equal(proxy.records[0].reservedUsd, null);
  assert.equal(proxy.records[0].reportedUsd, 0.001);
});
