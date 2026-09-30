import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertReconciledCharges, reserveCharge } from "./dataset-run.mjs";

const model = "deepseek/deepseek-v4.1-flash";
const endpointPath = `/models/${model}/endpoints`;
const upstream = "https://openrouter.ai/api/v1";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

async function readKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    return (await readFile(process.env.XPATHED_ENV_FILE ?? ".env", "utf8"))
      .split(/\r?\n/)
      .find((line) => /^OPENROUTER_API_KEY=/.test(line))
      ?.slice("OPENROUTER_API_KEY=".length)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function boundedRequest(body, pricing) {
  const allowed = new Set([
    "model",
    "messages",
    "max_tokens",
    "max_completion_tokens",
    "stream",
    "reasoning",
    "provider",
    "plugins",
    "response_format",
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "seed",
    "stop",
    "n",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
  ]);
  if (!object(body) || Object.keys(body).some((key) => !allowed.has(key)))
    throw new Error("Unsupported inference request fields");
  if (
    body.model !== model ||
    (body.stream != null && body.stream !== false) ||
    (body.n != null && body.n !== 1)
  )
    throw new Error("Only one non-streaming completion on the approved model is allowed");
  if (
    !Array.isArray(body.messages) ||
    body.messages.length < 1 ||
    body.messages.length > 64 ||
    body.messages.some(
      (message) =>
        !object(message) ||
        Object.keys(message).some(
          (key) => !["role", "content", "name", "tool_calls", "tool_call_id"].includes(key),
        ) ||
        !(
          typeof message.content === "string" ||
          (Array.isArray(message.content) &&
            message.content.every(
              (part) =>
                object(part) &&
                part.type === "text" &&
                typeof part.text === "string" &&
                Object.keys(part).every((key) => ["type", "text"].includes(key)),
            ))
        ),
    )
  )
    throw new Error("Only bounded text messages are supported");
  for (const limit of [body.max_tokens, body.max_completion_tokens].filter(
    (value) => value != null,
  ))
    if (!Number.isInteger(limit) || limit < 1 || limit > 4096)
      throw new Error("Output limit must be at most 4096 tokens");
  if (body.reasoning != null && (!object(body.reasoning) || body.reasoning.enabled !== false))
    throw new Error("Reasoning must be disabled");
  if (
    body.plugins != null &&
    (!Array.isArray(body.plugins) ||
      body.plugins.some(
        (plugin) =>
          !object(plugin) || plugin.id !== "context-compression" || plugin.enabled !== false,
      ))
  )
    throw new Error("Inference plugins must be disabled");
  if (
    body.provider != null &&
    (!object(body.provider) ||
      body.provider.allow_fallbacks === true ||
      [body.provider.only, body.provider.order].some(
        (route) =>
          route != null && (!Array.isArray(route) || route.length !== 1 || route[0] !== "wafer"),
      ))
  )
    throw new Error("Only the Wafer route without fallbacks is allowed");
  const request = {
    ...body,
    stream: false,
    max_tokens: Math.min(body.max_tokens ?? 4096, body.max_completion_tokens ?? 4096),
    reasoning: { enabled: false },
    provider: {
      only: ["wafer"],
      order: ["wafer"],
      allow_fallbacks: false,
      require_parameters: true,
      max_price: {
        prompt: Number((pricing.prompt * 1_000_000).toPrecision(15)),
        completion: Number((pricing.completion * 1_000_000).toPrecision(15)),
        request: pricing.request,
      },
    },
    plugins: [{ id: "context-compression", enabled: false }],
  };
  delete request.max_completion_tokens;
  return request;
}

// The caller owns listening; only this process receives the real provider key.
export async function createBudgetProxy({
  apiKey,
  ledgerPath = resolve(".artifacts/datasets/experiment-budget.json"),
  ceilingUsd = 5,
  fetchImpl = fetch,
  onRecord = async () => {},
} = {}) {
  apiKey ??= await readKey();
  if (!apiKey)
    throw new Error("Set OPENROUTER_API_KEY for the explicitly requested live comparison");
  if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0 || ceilingUsd > 5)
    throw new Error("Experiment ceiling must be at most $5 total");
  await mkdir(dirname(ledgerPath), { recursive: true });
  const lock = `${ledgerPath}.lock`;
  await mkdir(lock);
  let ledger, pricing, metadata;
  const persist = async () => {
    await writeFile(`${ledgerPath}.pending`, JSON.stringify(ledger, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(`${ledgerPath}.pending`, ledgerPath);
  };
  try {
    try {
      ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ledger = { version: 1, ceilingUsd, entries: [] };
    }
    if (
      ledger.version !== 1 ||
      !Number.isFinite(ledger.ceilingUsd) ||
      ledger.ceilingUsd <= 0 ||
      ledger.ceilingUsd > 5 ||
      !Array.isArray(ledger.entries) ||
      ledger.entries.some(
        (entry) =>
          !object(entry) ||
          !Number.isFinite(entry.reservedUsd) ||
          entry.reservedUsd <= 0 ||
          (entry.reportedUsd != null &&
            (!Number.isFinite(entry.reportedUsd) || entry.reportedUsd < 0)),
      )
    )
      throw new Error("Invalid experiment budget ledger");
    assertReconciledCharges(ledger);
    ledger.ceilingUsd = Math.min(ledger.ceilingUsd, ceilingUsd);
    const response = await fetchImpl(`${upstream}${endpointPath}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Current route pricing is unavailable");
    metadata = await response.json();
    const rate = metadata.data?.endpoints?.find((item) => item.tag === "wafer")?.pricing;
    if (
      !rate ||
      rate.overrides ||
      !Number.isFinite(Number(rate.prompt)) ||
      Number(rate.prompt) <= 0 ||
      !Number.isFinite(Number(rate.completion)) ||
      Number(rate.completion) <= 0 ||
      !Number.isFinite(Number(rate.request ?? 0)) ||
      Number(rate.request ?? 0) < 0
    )
      throw new Error("Unbounded or missing route prices");
    pricing = {
      prompt: Number(rate.prompt),
      completion: Number(rate.completion),
      request: Number(rate.request ?? 0),
      fetchedAt: new Date().toISOString(),
    };
    await persist();
  } catch (error) {
    await rm(lock, { recursive: true });
    throw error;
  }
  const records = [],
    attempts = new Set();
  let current,
    busy = false,
    blocked = false,
    closed = false;
  const safe = (value) => JSON.parse(JSON.stringify(value).replaceAll(apiKey, "[redacted]"));
  const retain = async (record) => {
    await onRecord(safe(record));
  };
  const server = createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(safe(value)));
    };
    const path = new URL(request.url, "http://evaluation").pathname.replace(/^\/api\/v1/, "");
    if (request.method === "GET" && path === endpointPath) return send(200, metadata);
    if (request.method !== "POST" || path !== "/chat/completions")
      return send(404, { error: { message: "Unknown evaluation provider route" } });
    if (closed || blocked || busy || !current || current.used)
      return send(409, {
        error: {
          message:
            "Inference blocked: missing attempt, retry, concurrent call or unreconciled charge",
        },
      });
    current.used = true;
    busy = true;
    const started = performance.now();
    const record = {
      id: randomUUID(),
      attemptId: current.id,
      createdAt: new Date().toISOString(),
      request: null,
      response: null,
      usage: null,
      reservedUsd: null,
      reportedUsd: null,
    };
    records.push(record);
    let reservation;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2_000_000) throw new Error("Inference request exceeds the evidence limit");
        chunks.push(chunk);
      }
      const body = boundedRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")), pricing);
      record.request = safe(body);
      const text = JSON.stringify(body);
      // UTF-8 bytes plus framing bound text tokenization; no image/audio inputs are allowed.
      const maximum =
        ((Buffer.byteLength(text) + 16384) * pricing.prompt +
          body.max_tokens * pricing.completion +
          pricing.request) *
        1.2;
      reserveCharge(ledger, maximum, record.id);
      reservation = ledger.entries.at(-1);
      reservation.attemptId = current.id;
      record.reservedUsd = maximum;
      await persist();
      await retain(record);
      record.forwarded = true;
      const result = await fetchImpl(`${upstream}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: text,
        signal: AbortSignal.timeout(45000),
      });
      record.status = result.status;
      record.response = safe(await result.text());
      const payload = JSON.parse(record.response);
      record.response = safe(payload);
      record.usage = safe(payload.usage ?? null);
      const cost = payload.usage?.cost;
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        reservation.reportedUsd = cost;
        record.reportedUsd = cost;
      }
      blocked = reservation.reportedUsd == null || cost > reservation.reservedUsd;
      if (blocked)
        record.error =
          "Provider charge is missing or exceeds its reservation; further calls are blocked";
      await persist();
      record.elapsedMs = performance.now() - started;
      await retain(record);
      send(result.status, payload);
    } catch (error) {
      blocked ||= reservation != null;
      record.error = safe(String(error.message));
      record.elapsedMs = performance.now() - started;
      try {
        await retain(record);
      } catch {
        blocked = true;
      }
      send(reservation ? 502 : 400, { error: { message: record.error } });
    } finally {
      busy = false;
    }
  });
  return {
    server,
    records,
    pricing,
    beginAttempt(id) {
      if (closed || blocked || busy || typeof id !== "string" || !id || attempts.has(id))
        throw new Error("Cannot begin an overlapping, repeated or blocked inference attempt");
      attempts.add(id);
      current = { id, used: false };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (server.listening)
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await rm(lock, { recursive: true });
    },
  };
}
