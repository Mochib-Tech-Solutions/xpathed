import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertReconciledCharges, reserveCharge, unresolvedCharge } from "./dataset-run.mjs";
import { githubBudget } from "./github-budget.mjs";

const model = "deepseek/deepseek-v4.1-flash";
const approved = {
  "deepseek/deepseek-v4.1-flash": { provider: "wafer", reasoning: { enabled: false } },
  "openai/gpt-6-luna": { provider: "openai", reasoning: { effort: "none" } },
  "google/gemini-3.8-flash": { provider: "google-ai-studio", reasoning: { effort: "low" } },
  "qwen/qwen3.8-flash": { provider: "alibaba", reasoning: { enabled: false } },
};
const equal = (left, right) =>
  object(left) &&
  object(right) &&
  Object.keys(left).length === Object.keys(right).length &&
  Object.entries(left).every(([key, value]) => value === right[key]);

function declaredProfiles(profiles) {
  const strict = profiles != null;
  profiles ??= [{ id: "default", model, ...approved[model] }];
  if (!Array.isArray(profiles) || !profiles.length) throw new Error("No approved profiles");
  const ids = new Set();
  return profiles.map((profile) => {
    const allowed = approved[profile?.model];
    if (
      !allowed ||
      typeof profile.id !== "string" ||
      !profile.id ||
      ids.has(profile.id) ||
      profile.provider !== allowed.provider ||
      !equal(profile.reasoning, allowed.reasoning) ||
      (profile.maxTokens != null &&
        (!Number.isInteger(profile.maxTokens) ||
          profile.maxTokens < 1 ||
          profile.maxTokens > 4096)) ||
      (profile.promptCacheOptions != null &&
        (profile.model !== "openai/gpt-6-luna" ||
          !equal(profile.promptCacheOptions, { mode: "explicit" })))
    )
      throw new Error("Unapproved model, route, reasoning or output profile");
    ids.add(profile.id);
    return { ...profile, strict, endpointPath: `/models/${profile.model}/endpoints` };
  });
}

function boundedPricing(endpoint) {
  const rate = endpoint?.pricing;
  if (
    !rate ||
    (endpoint.status != null && endpoint.status !== 0) ||
    (rate.overrides != null && !Array.isArray(rate.overrides))
  )
    throw new Error("Unbounded or missing route prices");
  const tiers = [rate];
  for (const tier of rate.overrides ?? []) {
    if (
      !object(tier) ||
      !Number.isFinite(tier.min_prompt_tokens) ||
      tier.min_prompt_tokens < 0 ||
      Object.keys(tier).some(
        (key) =>
          ![
            "min_prompt_tokens",
            "prompt",
            "completion",
            "request",
            "input_cache_read",
            "input_cache_write",
            "internal_reasoning",
          ].includes(key),
      )
    )
      throw new Error("Unbounded route pricing override");
    tiers.push({ ...rate, ...tier });
  }
  const number = (value, positive = false) => {
    const parsed = value == null || value === "" ? NaN : Number(value);
    if (!Number.isFinite(parsed) || (positive ? parsed <= 0 : parsed < 0))
      throw new Error("Unbounded or missing route prices");
    return parsed;
  };
  return {
    // Reserve the highest advertised tier, including prompt-cache writes and reasoning.
    prompt: Math.max(
      ...tiers.flatMap((tier) => [number(tier.prompt, true), number(tier.input_cache_write ?? 0)]),
    ),
    completion: Math.max(
      ...tiers.flatMap((tier) => [
        number(tier.completion, true),
        number(tier.internal_reasoning ?? 0),
      ]),
    ),
    request: Math.max(...tiers.map((tier) => number(tier.request ?? 0))),
    fetchedAt: new Date().toISOString(),
  };
}
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

function boundedRequest(body, profile) {
  const { pricing } = profile;
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
    "prompt_cache_options",
  ]);
  if (!object(body) || Object.keys(body).some((key) => !allowed.has(key)))
    throw new Error("Unsupported inference request fields");
  if (
    body.model !== profile.model ||
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
  if ((profile.strict || body.reasoning != null) && !equal(body.reasoning, profile.reasoning))
    throw new Error("Reasoning must match the approved profile");
  if (
    (profile.promptCacheOptions != null || body.prompt_cache_options != null) &&
    !equal(body.prompt_cache_options, profile.promptCacheOptions)
  )
    throw new Error("Prompt caching must match the approved profile");
  if (
    profile.maxTokens != null &&
    (body.max_tokens ?? body.max_completion_tokens) !== profile.maxTokens
  )
    throw new Error("Output limit must match the approved profile");
  if (
    profile.strict &&
    (body.response_format?.type !== "json_schema" ||
      body.response_format.json_schema?.strict !== true)
  )
    throw new Error("Qualification requires strict structured output");
  if (
    profile.strict &&
    [
      "temperature",
      "top_p",
      "frequency_penalty",
      "presence_penalty",
      "seed",
      "stop",
      "tools",
      "tool_choice",
      "parallel_tool_calls",
    ].some((key) => body[key] != null && !profile.endpoint.supported_parameters.includes(key))
  )
    throw new Error("Qualification request includes unsupported parameters");
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
      Object.keys(body.provider).some(
        (key) =>
          !["only", "order", "allow_fallbacks", "require_parameters", "max_price"].includes(key),
      ) ||
      body.provider.allow_fallbacks === true ||
      [body.provider.only, body.provider.order].some(
        (route) =>
          route != null &&
          (!Array.isArray(route) || route.length !== 1 || route[0] !== profile.provider),
      ))
  )
    throw new Error("Only the approved route without fallbacks is allowed");
  if (
    profile.strict &&
    (body.provider?.allow_fallbacks !== false ||
      body.provider.require_parameters !== true ||
      ![body.provider.only, body.provider.order].every(
        (route) => Array.isArray(route) && route.length === 1 && route[0] === profile.provider,
      ))
  )
    throw new Error("Qualification requires the exact pinned provider");
  const request = {
    ...body,
    stream: false,
    max_tokens: Math.min(body.max_tokens ?? 4096, body.max_completion_tokens ?? 4096),
    reasoning: profile.reasoning,
    provider: {
      only: [profile.provider],
      order: [profile.provider],
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

export function validateBudgetLedger(ledger) {
  if (
    !object(ledger) ||
    ledger.version !== 1 ||
    !Number.isFinite(ledger.ceilingUsd) ||
    ledger.ceilingUsd <= 0 ||
    ledger.ceilingUsd > 5 ||
    (Object.hasOwn(ledger, "remoteAuthority") &&
      (typeof ledger.remoteAuthority !== "string" ||
        !/^github:[a-z\d][a-z\d-]*\/[a-z\d._-]+:evaluation-budget:experiment-budget\.json$/.test(
          ledger.remoteAuthority,
        ))) ||
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
}

// The caller owns listening; only this process receives the real provider key.
export async function createBudgetProxy({
  apiKey,
  profiles,
  ledgerPath = resolve(".artifacts/datasets/experiment-budget.json"),
  ceilingUsd = 5,
  fetchImpl = fetch,
  onRecord = async () => {},
  githubRepository = process.env.XPATHED_BUDGET_GITHUB_REPOSITORY,
  githubToken = process.env.GH_TOKEN,
} = {}) {
  const configured = declaredProfiles(profiles);
  apiKey ??= await readKey();
  if (!apiKey)
    throw new Error("Set OPENROUTER_API_KEY for the explicitly requested live comparison");
  if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0 || ceilingUsd > 5)
    throw new Error("Experiment ceiling must be at most $5 total");
  const redact = (text) =>
    [apiKey, githubToken]
      .filter(Boolean)
      .reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
  await mkdir(dirname(ledgerPath), { recursive: true });
  const lock = `${ledgerPath}.lock`;
  await mkdir(lock);
  let ledger, remote;
  const persist = async () => {
    await writeFile(`${ledgerPath}.pending`, JSON.stringify(ledger, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(`${ledgerPath}.pending`, ledgerPath);
    await remote?.persist(ledger);
  };
  try {
    try {
      ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ledger = { version: 1, ceilingUsd, entries: [] };
    }
    if (
      object(ledger) &&
      Object.hasOwn(ledger, "remoteAuthority") &&
      (typeof githubRepository !== "string" ||
        ledger.remoteAuthority !==
          `github:${githubRepository.toLowerCase()}:evaluation-budget:experiment-budget.json`)
    )
      throw new Error("Local budget requires its matching GitHub authority");
    if (githubRepository) {
      remote = await githubBudget(githubRepository, githubToken, fetchImpl);
      ledger = remote.ledger;
    }
    validateBudgetLedger(ledger);
    ledger.ceilingUsd = Math.min(ledger.ceilingUsd, ceilingUsd);
    for (const profile of configured) {
      const response = await fetchImpl(`${upstream}${profile.endpointPath}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Current route pricing is unavailable");
      profile.metadata = await response.json();
      profile.endpoint = profile.metadata.data?.endpoints?.find(
        (item) => item.tag === profile.provider,
      );
      profile.pricing = boundedPricing(profile.endpoint);
      const canonical = profile.endpoint.name?.split(" | ").at(-1);
      profile.canonicalModel =
        typeof canonical === "string" && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(canonical)
          ? canonical
          : null;
      profile.acceptedModels = [
        ...new Set([profile.model, profile.canonicalModel].filter(Boolean)),
      ];
      if (
        profile.strict &&
        !["response_format", "structured_outputs", "reasoning", "max_tokens"].every((parameter) =>
          profile.endpoint.supported_parameters?.includes(parameter),
        )
      )
        throw new Error("Approved route does not advertise the required parameters");
    }
    await persist();
  } catch (error) {
    await rm(lock, { recursive: true });
    throw new Error(redact(String(error.message)));
  }
  const records = [],
    attempts = new Set();
  let current,
    busy = false,
    blocked = false,
    closed = false,
    idle = Promise.resolve(),
    closing;
  const safe = (value) => JSON.parse(redact(JSON.stringify(value)));
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
    const metadataProfile = configured.find((profile) => profile.endpointPath === path);
    if (request.method === "GET" && metadataProfile) return send(200, metadataProfile.metadata);
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
    const finished = Promise.withResolvers();
    idle = finished.promise;
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
      const profile = current.profile;
      const { pricing } = profile;
      record.profileId = profile.id;
      record.pricing = pricing;
      record.requestedIdentity = { model: profile.model, provider: profile.provider };
      const body = boundedRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")), profile);
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
          "X-OpenRouter-Cache": "false",
          "X-OpenRouter-Metadata": "enabled",
        },
        body: text,
        signal: AbortSignal.timeout(45000),
      });
      record.status = result.status;
      record.headers = Object.fromEntries(
        [...result.headers].filter(([key]) =>
          /^(x-openrouter-|x-request-id$|retry-after$|cache-control$|age$)/i.test(key),
        ),
      );
      record.responseReuseDisabled = true;
      record.response = safe(await result.text());
      const payload = JSON.parse(record.response);
      record.response = safe(payload);
      record.usage = safe(payload.usage ?? null);
      record.observedIdentity = {
        model: payload.model ?? null,
        provider: payload.provider ?? null,
        generationId: payload.id ?? null,
        serviceTier: payload.service_tier ?? null,
      };
      record.identityValid =
        (payload.service_tier == null || ["default", "standard"].includes(payload.service_tier)) &&
        profile.acceptedModels.includes(payload.model) &&
        typeof payload.provider === "string" &&
        [profile.provider, profile.endpoint.provider_name].some(
          (provider) =>
            typeof provider === "string" &&
            provider.toLowerCase() === payload.provider.toLowerCase(),
        );
      record.responseCacheHit = Object.entries(record.headers).some(
        ([key, value]) => key.includes("cache") && /(^|[ ,;])hit([ ,;]|$)/i.test(value),
      );
      const cost = payload.usage?.cost;
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        reservation.reportedUsd = cost;
        record.reportedUsd = cost;
      }
      blocked = reservation.reportedUsd == null || cost > reservation.reservedUsd;
      if (blocked)
        record.error =
          "Provider charge is missing or exceeds its reservation; further calls are blocked";
      if (profile.strict && (!record.identityValid || record.responseCacheHit)) {
        blocked = true;
        record.error =
          "Provider identity mismatch or response cache hit; further qualification calls are blocked";
      }
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
      finished.resolve();
    }
  });
  return {
    server,
    records,
    pricing: configured[0].pricing,
    profiles: configured,
    get budget() {
      const spentUsd = ledger.entries.reduce(
        (sum, entry) => sum + (entry.reportedUsd ?? entry.reservedUsd),
        0,
      );
      const reviewed = ledger.entries.filter(
        (entry) => entry.reportedUsd == null && !unresolvedCharge(entry),
      );
      return {
        ceilingUsd: ledger.ceilingUsd,
        spentUsd,
        remainingUsd: Math.max(0, ledger.ceilingUsd - spentUsd),
        pendingCharges: ledger.entries.filter(unresolvedCharge).length,
        reviewedReserveCharges: reviewed.length,
        reviewedReserveUsd: reviewed.reduce((sum, entry) => sum + entry.reservedUsd, 0),
      };
    },
    beginAttempt(id, profileId = configured[0].id) {
      const profile = configured.find((item) => item.id === profileId);
      if (!profile) throw new Error("Unknown inference profile");
      if (closed || blocked || busy || typeof id !== "string" || !id || attempts.has(id))
        throw new Error("Cannot begin an overlapping, repeated or blocked inference attempt");
      attempts.add(id);
      current = { id, profile, used: false };
    },
    awaitIdle() {
      return idle;
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        if (server.listening)
          await new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        // Disconnected callers can close their sockets before upstream accounting finishes.
        await idle;
        await rm(lock, { recursive: true });
      })();
      return closing;
    },
  };
}
