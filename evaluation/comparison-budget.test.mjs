import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createBudgetProxy } from "./comparison-budget.mjs";

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

async function setup(
  t,
  { completion, ceilingUsd, initial, onRecord, profiles, metadata = pricing, github } = {},
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
    assert.ok(ledger.entries.at(-1).reservedUsd > 0);
    return completion
      ? completion(url, options)
      : Response.json({
          id: "generation-1",
          usage: { cost: 0.001, prompt_tokens: 50, completion_tokens: 20 },
          choices: [],
        });
  };
  proxy = await createBudgetProxy({
    apiKey: "test-provider-secret",
    ledgerPath,
    fetchImpl,
    ceilingUsd,
    onRecord,
    profiles,
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
  proxy.beginAttempt("hosted-attempt");
  assert.equal((await post()).status, 200);
  assert.equal(github.ledger.entries[1].reportedUsd, 0.001);
  assert.deepEqual(JSON.parse(await readFile(ledgerPath, "utf8")), github.ledger);
  for (const stage of ["reservation", "reconciliation"]) {
    const duration = proxy.records[0].remoteAccountingMs[stage];
    assert.ok(Number.isFinite(duration) && duration >= 0);
  }
});

test("a complete prepared forecast bounds both arms before any paid request and blocks growth beyond its allocation", async (t) => {
  const { proxy, post, calls } = await setup(t);
  const forecast = proxy.forecastRequests([
    { id: "before", profileId: "default", request: input },
    { id: "after", profileId: "default", request: input },
  ]);
  assert.equal(calls.length, 0);
  assert.equal(forecast.fits, true);
  assert.equal(forecast.projectedUsd, forecast.reservations[0].maximumUsd * 2);
  proxy.beginAttempt("before", "default", forecast.reservations[0].maximumUsd);
  assert.equal((await post()).status, 200);
  proxy.beginAttempt("after", "default", forecast.reservations[1].maximumUsd);
  assert.equal(
    (await post({ ...input, messages: [{ role: "user", content: "x".repeat(100000) }] })).status,
    400,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    proxy.forecastRequests(
      Array.from({ length: 2000 }, (_, i) => ({
        id: String(i),
        profileId: "default",
        request: input,
      })),
    ).fits,
    false,
  );
});

test("missing remote state cannot initialize a new campaign and local spending cannot substitute for it", async (t) => {
  for (const status of [404, 403, 503]) {
    await assert.rejects(
      setup(t, {
        initial: { version: 1, ceilingUsd: 5, entries: [] },
        github: { fetch: async () => Response.json({ message: "test-github-secret" }, { status }) },
      }),
      (error) =>
        /GitHub budget read failed/.test(error.message) &&
        !error.message.includes("test-github-secret"),
    );
  }
  await assert.rejects(
    setup(t, {
      github: githubBudget({ version: 1, ceilingUsd: 5, entries: [] }),
    }),
    /authority mismatch/,
  );
});

test("conflicting hosted writers cannot forward a request from a stale ledger", async (t) => {
  const github = githubBudget({
    version: 1,
    ceilingUsd: 5,
    remoteAuthority: "github:example/private:evaluation-budget:experiment-budget.json",
    entries: [],
  });
  const first = await setup(t, { github });
  const second = await setup(t, { github });
  first.proxy.beginAttempt("current-writer");
  assert.equal((await first.post()).status, 200);
  second.proxy.beginAttempt("stale-writer");
  assert.equal((await second.post()).status, 502);
  assert.equal(second.calls.length, 0);
  assert.throws(() => second.proxy.beginAttempt("retry"), /blocked/);
  assert.equal(github.ledger.entries.length, 1);
  assert.equal(github.ledger.entries[0].attemptId, "current-writer");
});

test("remote reconciliation failure retains a blocking reservation even when local accounting knows the cost", async (t) => {
  const github = githubBudget({
    version: 1,
    ceilingUsd: 5,
    remoteAuthority: "github:example/private:evaluation-budget:experiment-budget.json",
    entries: [],
  });
  const originalFetch = github.fetch;
  let failWrites = false;
  github.fetch = (url, options) =>
    failWrites && options.method === "PUT"
      ? Promise.reject(new Error("test-github-secret transport failure"))
      : originalFetch(url, options);
  const { proxy, post, calls } = await setup(t, {
    github,
    completion: () => {
      failWrites = true;
      return Response.json({ usage: { cost: 0.001 } });
    },
  });
  proxy.beginAttempt("unreconciled-remotely");
  const response = await post();
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes("test-github-secret"));
  assert.equal(calls.length, 1);
  assert.equal(github.ledger.entries[0].reportedUsd, null);
  assert.throws(() => proxy.beginAttempt("next"), /blocked/);
  await assert.rejects(setup(t, { github }), /Unreconciled/);
});

test("an ambiguous remote reservation write never forwards and blocks the next hosted run", async (t) => {
  const github = githubBudget({
    version: 1,
    ceilingUsd: 5,
    remoteAuthority: "github:example/private:evaluation-budget:experiment-budget.json",
    entries: [],
  });
  const { proxy, post, calls } = await setup(t, { github });
  const originalFetch = github.fetch;
  github.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    if (options.method === "PUT") throw new Error("Lost receipt with test-github-secret");
    return response;
  };
  proxy.beginAttempt("lost-receipt");
  const response = await post();
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes("test-github-secret"));
  assert.equal(calls.length, 0);
  assert.equal(github.ledger.entries[0].reportedUsd, null);
  await assert.rejects(setup(t, { github }), /Unreconciled/);
});

test("caller cancellation leaves the remote reservation blocking until provider accounting completes", async (t) => {
  const github = githubBudget({
    version: 1,
    ceilingUsd: 5,
    remoteAuthority: "github:example/private:evaluation-budget:experiment-budget.json",
    entries: [],
  });
  const started = Promise.withResolvers();
  const upstream = Promise.withResolvers();
  const { proxy, post } = await setup(t, {
    github,
    completion: () => {
      started.resolve();
      return upstream.promise;
    },
  });
  proxy.beginAttempt("cancelled-client");
  const controller = new AbortController();
  const request = post(input, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(request, /abort/i);
  try {
    assert.equal(github.ledger.entries[0].reportedUsd, null);
    await assert.rejects(setup(t, { github }), /Unreconciled/);
  } finally {
    upstream.reject(new Error("Provider result unavailable"));
    await proxy.awaitIdle();
  }
  assert.equal(github.ledger.entries[0].reportedUsd, null);
  await assert.rejects(setup(t, { github }), /Unreconciled/);
});

test("a migrated local ledger cannot spend without its matching remote authority", async (t) => {
  const initial = {
    version: 1,
    ceilingUsd: 5,
    remoteAuthority: "github:example/private:evaluation-budget:experiment-budget.json",
    entries: [],
  };
  await assert.rejects(setup(t, { initial }), /authority/i);
  await assert.rejects(
    setup(t, {
      initial: {
        ...initial,
        remoteAuthority: "github:example/other:evaluation-budget:experiment-budget.json",
      },
      github: githubBudget(initial),
    }),
    /authority/i,
  );
});

test("startup failures never expose provider or GitHub authentication values", async (t) => {
  await assert.rejects(
    setup(t, {
      github: githubBudget({
        version: 1,
        ceilingUsd: 5,
        remoteAuthority: "github:example/private:evaluation-budget:experiment-budget.json",
        entries: [],
      }),
      metadata: () => {
        throw new Error("test-provider-secret test-github-secret unavailable");
      },
    }),
    (error) =>
      !error.message.includes("test-provider-secret") &&
      !error.message.includes("test-github-secret") &&
      /unavailable/.test(error.message),
  );
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
          await assert.rejects(
            createBudgetProxy({ apiKey: "key", ledgerPath, fetchImpl }),
            /Unreconciled/,
          );
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
    max_price: { prompt: 0.1, completion: 0.5, request: 0 },
  });
  assert.equal(effective.max_tokens, 4096);
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-provider-secret");
  assert.equal(retained[0].reportedUsd, null);
  assert.equal(retained.at(-1).reportedUsd, 0.001);
  assert.equal(proxy.records[0].usage.prompt_tokens, 50);
  assert.ok(proxy.records[0].elapsedMs >= 0);
  assert.ok(!JSON.stringify(proxy.records).includes("test-provider-secret"));
  assert.equal(JSON.parse(await readFile(ledgerPath, "utf8")).entries[0].reportedUsd, 0.001);
  assert.deepEqual(await (await fetch(`${base}/models/${model}/endpoints`)).json(), pricing);
  proxy.beginAttempt("case:stagehand");
  assert.equal((await post()).status, 200);
  assert.equal(calls.length, 2);
});

test("shared ledger lock, previous spend and a lowered ceiling prevent additional payment", async (t) => {
  const { proxy, post, calls, ledgerPath, fetchImpl } = await setup(t, {
    initial: {
      version: 1,
      ceilingUsd: 5,
      entries: [{ id: "previous", reservedUsd: 5, reportedUsd: 4.999 }],
    },
  });
  await assert.rejects(createBudgetProxy({ apiKey: "key", ledgerPath, fetchImpl }), /EEXIST/);
  proxy.beginAttempt("over-budget");
  assert.equal((await post()).status, 400);
  assert.equal(calls.length, 0);
  assert.equal(proxy.records[0].reservedUsd, null);
  assert.match(proxy.records[0].error, /budget/);
  assert.equal(JSON.parse(await readFile(ledgerPath, "utf8")).entries.length, 1);
  await proxy.close();
  const reopened = await createBudgetProxy({ apiKey: "key", ledgerPath, fetchImpl, ceilingUsd: 4 });
  await reopened.close();
  assert.equal(JSON.parse(await readFile(ledgerPath, "utf8")).ceilingUsd, 4);
});

test("an explicit full-reservation review permits reopening without inventing provider cost", async (t) => {
  const initial = {
    version: 1,
    ceilingUsd: 5,
    entries: [
      {
        id: "reviewed-timeout",
        reservedUsd: 5,
        reportedUsd: null,
        reservationReview: {
          reason: "Operator authorized resume with full maximum charged",
          reviewedAt: "2026-10-01T12:00:00.000Z",
          chargedUsd: 5,
        },
      },
    ],
  };
  const { proxy, post, calls, ledgerPath } = await setup(t, { initial });
  assert.equal(proxy.budget.pendingCharges, 0);
  assert.equal(proxy.budget.spentUsd, 5);
  assert.equal(proxy.budget.remainingUsd, 0);
  assert.equal(proxy.budget.reviewedReserveCharges, 1);
  assert.equal(proxy.budget.reviewedReserveUsd, 5);
  proxy.beginAttempt("cannot-spend-reviewed-maximum");
  assert.equal((await post()).status, 400);
  assert.equal(calls.length, 0);
  assert.deepEqual(JSON.parse(await readFile(ledgerPath, "utf8")), initial);
});

test("a reviewed reservation does not automatically review a new unknown charge", async (t) => {
  const reviewed = {
    id: "previous",
    reservedUsd: 0.1,
    reportedUsd: null,
    reservationReview: {
      reason: "Explicit resume approval",
      reviewedAt: "2026-10-01T12:00:00.000Z",
      chargedUsd: 0.1,
    },
  };
  const { proxy, post, ledgerPath, fetchImpl } = await setup(t, {
    initial: { version: 1, ceilingUsd: 5, entries: [reviewed] },
    completion: () => Response.json({ choices: [], usage: { prompt_tokens: 2 } }),
  });
  proxy.beginAttempt("new-unknown");
  await post();
  assert.equal(proxy.budget.pendingCharges, 1);
  assert.equal(proxy.budget.reviewedReserveCharges, 1);
  assert.equal(proxy.budget.reviewedReserveUsd, 0.1);
  assert.throws(() => proxy.beginAttempt("blocked"), /blocked/);
  const retained = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.deepEqual(retained.entries[0], reviewed);
  assert.equal(retained.entries[1].reportedUsd, null);
  assert.equal(retained.entries[1].reservationReview, undefined);
  await proxy.close();
  await assert.rejects(createBudgetProxy({ apiKey: "key", ledgerPath, fetchImpl }), /Unreconciled/);
});

test("ledger initialization rejects a reduced reservation review before fetching prices", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "xpathed-invalid-review-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerPath = join(directory, "ledger.json");
  await writeFile(
    ledgerPath,
    JSON.stringify({
      version: 1,
      ceilingUsd: 5,
      entries: [
        {
          reservedUsd: 1,
          reportedUsd: null,
          reservationReview: {
            reason: "Operator review",
            reviewedAt: "2026-10-01T12:00:00.000Z",
            chargedUsd: 0.5,
          },
        },
      ],
    }),
  );
  let calls = 0;
  await assert.rejects(
    createBudgetProxy({
      apiKey: "key",
      ledgerPath,
      fetchImpl: async () => {
        calls++;
        return Response.json(pricing);
      },
    }),
    /Unreconciled/,
  );
  assert.equal(calls, 0);
});

test("missing, excessive and malformed provider charges retain reservations and block later runs", async (t) => {
  for (const [name, completion] of [
    ["missing", () => Response.json({ choices: [], usage: { prompt_tokens: 2 } })],
    ["excessive", () => Response.json({ choices: [], usage: { cost: 4 } })],
    ["malformed", () => new Response("not JSON")],
    [
      "transport",
      () => {
        throw new Error("network failure");
      },
    ],
  ])
    await t.test(name, async (t) => {
      const { proxy, post, calls, ledgerPath, fetchImpl } = await setup(t, { completion });
      proxy.beginAttempt("first");
      await post();
      assert.equal(calls.length, 1);
      assert.equal((await post()).status, 409);
      assert.throws(() => proxy.beginAttempt("next"), /blocked/);
      const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
      assert.equal(ledger.entries.length, 1);
      assert.ok(ledger.entries[0].reservedUsd > 0);
      assert.equal(ledger.entries[0].reportedUsd, name === "excessive" ? 4 : null);
      await proxy.close();
      await assert.rejects(
        createBudgetProxy({ apiKey: "key", ledgerPath, fetchImpl }),
        /Unreconciled/,
      );
    });
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
    proxy.beginAttempt(profile.id, profile.id);
    assert.equal((await post(profileInput(profile))).status, 200);
  }
  assert.equal(calls.length, 4);
  assert.deepEqual(proxy.budget, {
    ceilingUsd: 5,
    spentUsd: 0.004,
    remainingUsd: 4.996,
    pendingCharges: 0,
    reviewedReserveCharges: 0,
    reviewedReserveUsd: 0,
  });
  assert.equal(JSON.parse(await readFile(ledgerPath, "utf8")).entries.length, 4);
  for (const [index, call] of calls.entries()) {
    const profile = qualificationProfiles[index];
    const request = JSON.parse(call.options.body);
    assert.equal(request.model, profile.model);
    assert.deepEqual(request.reasoning, profile.reasoning);
    assert.deepEqual(request.provider.only, [profile.provider]);
    assert.equal(call.options.headers["X-OpenRouter-Cache"], "false");
    assert.equal(request.provider.max_price.prompt, 0.25);
    assert.equal(request.provider.max_price.completion, 0.75);
    const record = proxy.records[index];
    assert.deepEqual(record.remoteAccountingMs, { reservation: 0, reconciliation: 0 });
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
    proxy.beginAttempt(`invalid-profile-${index}`, profile.id);
    assert.equal((await post(request)).status, 400);
  }
  assert.equal(calls.length, 0);
});

test("unapproved profiles and unknown price overrides fail closed at startup", async () => {
  for (const profile of [
    { ...qualificationProfiles[0], provider: "openai/fast" },
    { ...qualificationProfiles[1], reasoning: { enabled: false } },
    { ...qualificationProfiles[2], model: "deepseek/latest" },
    { ...qualificationProfiles[3], provider: "alibaba/fast" },
    { ...qualificationProfiles[3], reasoning: { enabled: true } },
  ])
    await assert.rejects(createBudgetProxy({ apiKey: "key", profiles: [profile] }), /Unapproved/);
  const directory = await mkdtemp(join(tmpdir(), "xpathed-unbounded-price-"));
  try {
    const metadata = profileMetadata("openai/gpt-6-luna");
    metadata.data.endpoints[0].pricing.overrides[0].start_time = "12:00";
    await assert.rejects(
      createBudgetProxy({
        apiKey: "key",
        profiles: [qualificationProfiles[0]],
        ledgerPath: join(directory, "ledger.json"),
        fetchImpl: async () => Response.json(metadata),
      }),
      /Unbounded/,
    );
    await assert.rejects(readFile(join(directory, "ledger.json")), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
      proxy.beginAttempt("mismatch", profile.id);
      assert.equal((await post(profileInput(profile))).status, 200);
      assert.equal(proxy.records[0].identityValid, reason === "cache");
      assert.equal(proxy.records[0].responseCacheHit, reason === "cache");
      assert.equal(JSON.parse(await readFile(ledgerPath, "utf8")).entries[0].reportedUsd, 0.001);
      assert.throws(() => proxy.beginAttempt("next", profile.id), /blocked/);
    });
});
