import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function setup(t, { completion, ceilingUsd, initial, onRecord } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "xpathed-comparison-budget-"));
  const ledgerPath = join(directory, "experiment-budget.json");
  if (initial) await writeFile(ledgerPath, JSON.stringify(initial));
  const calls = [];
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/endpoints")) return Response.json(pricing);
    calls.push({ url, options });
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.equal(
      ledger.entries.at(-1).reportedUsd,
      null,
      "persist a reservation before the paid request",
    );
    assert.ok(ledger.entries.at(-1).reservedUsd > 0);
    return completion
      ? completion()
      : Response.json({
          id: "generation-1",
          usage: { cost: 0.001, prompt_tokens: 50, completion_tokens: 20 },
          choices: [],
        });
  };
  const proxy = await createBudgetProxy({
    apiKey: "test-provider-secret",
    ledgerPath,
    fetchImpl,
    ceilingUsd,
    onRecord,
  });
  t.after(async () => {
    await proxy.close();
    await rm(directory, { recursive: true, force: true });
  });
  proxy.server.listen(0, "127.0.0.1");
  await once(proxy.server, "listening");
  const base = `http://127.0.0.1:${proxy.server.address().port}/api/v1`;
  const post = (body = input) =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { proxy, post, base, calls, ledgerPath, fetchImpl };
}

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
