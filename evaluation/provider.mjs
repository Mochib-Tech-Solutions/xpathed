import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual, parseEnv } from "node:util";
import { reserveCharge } from "./accounting/ledger.mjs";
import { githubBudget } from "./accounting/github.mjs";

const model = "deepseek/deepseek-v4.1-flash";
export const contextPlanningQuestions = Object.freeze({
  appearance: Object.freeze({
    type: "noul",
    instructions:
      "Does identifying any requested target or reference element require visual color or appearance evidence, including background, foreground, border, image or icon appearance?",
  }),
  layout: Object.freeze({
    type: "noul",
    instructions:
      "Does identifying or ordering any requested target or reference element require visual position, direction, distance, size or spatial relations?",
  }),
});
const decisionModel = "typesafe/jev-1.13";
const decisionProvider = { only: ["typesafe"], order: ["typesafe"], allow_fallbacks: false };

function frozenDecision(request) {
  if (
    !object(request) ||
    !isDeepStrictEqual(Object.keys(request).sort(), ["model", "provider", "questions", "state"]) ||
    request.model !== decisionModel ||
    typeof request.state !== "string" ||
    !request.state.trim() ||
    request.state.length > 4000 ||
    !isDeepStrictEqual(request.questions, contextPlanningQuestions) ||
    !isDeepStrictEqual(request.provider, decisionProvider)
  )
    throw new Error(
      "Context planning requires the frozen Jev questions, route and original instruction",
    );
  return structuredClone(request);
}
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
    const allowed =
      profile?.id === "deepseek-deepinfra" && profile.model === model
        ? { provider: "deepinfra/fp8", reasoning: { enabled: false } }
        : profile?.id === "luna-azure" && profile.model === "openai/gpt-6-luna"
          ? { provider: "azure", reasoning: { effort: "none" } }
          : approved[profile?.model];
    if (
      !allowed ||
      (profile.id === "luna-azure" &&
        (profile.model !== "openai/gpt-6-luna" ||
          !equal(profile.promptCacheOptions, { mode: "explicit" }))) ||
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
    return {
      ...profile,
      strict,
      outputLimitParameter: profile.id === "luna-azure" ? "max_completion_tokens" : "max_tokens",
      endpointPath: `/models/${profile.model}/endpoints`,
    };
  });
}

function boundedPricing(endpoint, freeCompletion = false) {
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
        number(tier.completion, !freeCompletion),
        number(tier.internal_reasoning ?? 0),
      ]),
    ),
    request: Math.max(...tiers.map((tier) => number(tier.request ?? 0))),
    fetchedAt: new Date().toISOString(),
  };
}
const upstream = "https://openrouter.ai/api/v1";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export async function readEvaluationKey(env = process.env) {
  if (env.OPENROUTER_EVAL_API_KEY?.trim()) return env.OPENROUTER_EVAL_API_KEY.trim();
  try {
    const key = parseEnv(
      await readFile(env.XPATHED_ENV_FILE ?? ".env", "utf8"),
    ).OPENROUTER_EVAL_API_KEY?.trim();
    if (key) return key;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return undefined;
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
    body.max_tokens != null &&
    body.max_completion_tokens != null &&
    body.max_tokens !== body.max_completion_tokens
  )
    throw new Error("Output limit aliases must agree");
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
    },
    plugins: [{ id: "context-compression", enabled: false }],
  };
  delete request.max_completion_tokens;
  if (profile.outputLimitParameter === "max_completion_tokens") {
    request.max_completion_tokens = request.max_tokens;
    delete request.max_tokens;
  }
  return request;
}

function maximumCharge(body, pricing) {
  if (!pricing) return null;
  const estimate =
    ((Buffer.byteLength(JSON.stringify(body)) + 16384) * pricing.prompt +
      (body.max_tokens ?? body.max_completion_tokens) * pricing.completion +
      pricing.request) *
    1.2;
  return Number.isFinite(estimate) ? estimate : null;
}

export function validateBudgetLedger(ledger) {
  if (
    !object(ledger) ||
    ledger.version !== 1 ||
    !Array.isArray(ledger.entries) ||
    new Set(ledger.entries.map((entry) => entry.id)).size !== ledger.entries.length ||
    ledger.entries.some(
      (entry) =>
        !object(entry) ||
        typeof entry.id !== "string" ||
        (entry.reservedUsd != null &&
          (!Number.isFinite(entry.reservedUsd) || entry.reservedUsd < 0)) ||
        (entry.reportedUsd != null &&
          (!Number.isFinite(entry.reportedUsd) || entry.reportedUsd < 0)),
    )
  )
    throw new Error("Invalid accounting ledger");
}

// The caller owns listening; only this process receives the real provider key.
export async function createBudgetProxy({
  apiKey,
  profiles,
  ledgerPath = resolve(".artifacts/datasets/experiment-budget.json"),
  budgetPolicy = "provider-limit",
  contextPlanning = false,
  fetchImpl = fetch,
  onRecord = async () => {},
  githubRepository = process.env.XPATHED_BUDGET_GITHUB_REPOSITORY,
  githubToken = process.env.GH_TOKEN,
} = {}) {
  const configured = declaredProfiles(profiles);
  if (budgetPolicy !== "provider-limit") throw new Error("Unknown budget policy");
  if (typeof contextPlanning !== "boolean")
    throw new Error("Context planning requires explicit provider-limit evaluation mode");
  for (const profile of configured) profile.budgetPolicy = budgetPolicy;
  apiKey ??= await readEvaluationKey();
  if (!apiKey)
    throw new Error("Set OPENROUTER_EVAL_API_KEY for the explicitly requested live evaluation");
  const redact = (text) =>
    [apiKey, githubToken]
      .filter(Boolean)
      .reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
  const lock = `${ledgerPath}.lock`;
  let ledger, remote, decisionMetadata, decisionPricing;
  const accountingWarnings = [];
  let ledgerWritable = false,
    lockOwned = false;
  try {
    await mkdir(dirname(ledgerPath), { recursive: true });
    await mkdir(lock);
    ledgerWritable = true;
    lockOwned = true;
  } catch (error) {
    accountingWarnings.push(redact(String(error.message)));
  }
  const warn = (error, record) => {
    const warning = redact(String(error.message));
    accountingWarnings.push(warning);
    if (record) record.accountingWarning = warning;
  };
  const persist = async (record, stage) => {
    const started = performance.now();
    if (ledgerWritable) {
      try {
        await writeFile(`${ledgerPath}.pending`, JSON.stringify(ledger, null, 2) + "\n", {
          mode: 0o600,
        });
        await rename(`${ledgerPath}.pending`, ledgerPath);
      } catch (error) {
        warn(error, record);
        ledgerWritable = false;
      }
    }
    if (remote) {
      try {
        await remote.persist(ledger);
      } catch (error) {
        warn(error, record);
        remote = null;
      }
    }
    if (record) record.remoteAccountingMs[stage] = performance.now() - started;
  };
  try {
    try {
      ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        accountingWarnings.push(redact(String(error.message)));
        ledgerWritable = false;
      }
      ledger = { version: 1, budgetPolicy, entries: [] };
    }
    if (githubRepository) {
      try {
        remote = await githubBudget(githubRepository, githubToken, fetchImpl);
        validateBudgetLedger(remote.ledger);
        const entries = new Map(remote.ledger.entries.map((entry) => [entry.id, entry]));
        for (const entry of ledger.entries ?? [])
          if (
            !entries.has(entry.id) ||
            (entries.get(entry.id).reportedUsd == null && entry.reportedUsd != null)
          )
            entries.set(entry.id, entry);
        ledger = { ...remote.ledger, entries: [...entries.values()] };
      } catch (error) {
        warn(error);
        remote = null;
      }
    }
    // Preserve historical entries; their old ceilings are metadata only.
    ledger.budgetPolicy = "provider-limit";
    try {
      validateBudgetLedger(ledger);
    } catch (error) {
      accountingWarnings.push(redact(String(error.message)));
      ledgerWritable = false;
      remote = null;
      ledger = { version: 1, budgetPolicy, entries: [] };
    }
    for (const profile of configured) {
      try {
        const response = await fetchImpl(`${upstream}${profile.endpointPath}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error("Route metadata unavailable");
        profile.metadata = await response.json();
        profile.endpoint = profile.metadata.data?.endpoints?.find(
          (item) => item.tag === profile.provider,
        );
      } catch (error) {
        profile.metadataWarning = redact(String(error.message));
      }
      profile.endpoint ??= { provider_name: profile.provider.split("/")[0] };
      try {
        profile.pricing = boundedPricing(profile.endpoint);
      } catch {
        profile.pricing = null;
      }
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
        profile.endpoint.supported_parameters &&
        !["response_format", "structured_outputs", "reasoning", profile.outputLimitParameter].every(
          (parameter) => profile.endpoint.supported_parameters?.includes(parameter),
        )
      )
        throw new Error("Approved route does not advertise the required parameters");
    }
    if (contextPlanning) {
      let endpoint;
      try {
        const response = await fetchImpl(`${upstream}/models/${decisionModel}/endpoints`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error("Context planning route metadata is unavailable");
        decisionMetadata = await response.json();
        endpoint = decisionMetadata.data?.endpoints?.find((item) => item.tag === "typesafe");
      } catch (error) {
        warn(error);
      }
      if (endpoint && (endpoint.status !== 0 || endpoint.provider_name !== "TypeSafe"))
        throw new Error("The pinned TypeSafe route is not operational");
      try {
        decisionPricing = boundedPricing(endpoint, true);
      } catch {
        decisionPricing = null;
      }
    }
    await persist();
  } catch (error) {
    if (lockOwned) await rm(lock, { recursive: true }).catch((error) => warn(error));
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
  const newRecord = () => {
    const record = {
      id: randomUUID(),
      attemptId: current.id,
      createdAt: new Date().toISOString(),
      request: null,
      response: null,
      usage: null,
      reservedUsd: null,
      reportedUsd: null,
      remoteAccountingMs: { reservation: 0, reconciliation: 0 },
    };
    records.push(record);
    return record;
  };
  const reserve = async (record, maximum) => {
    reserveCharge(ledger, maximum, record.id);
    current.reservation = ledger.entries.at(-1);
    current.reservation.attemptId = current.id;
    record.reservedUsd = maximum;
    await persist(record, "reservation");
    await retain(record);
  };
  const decisionEstimate = (request) => {
    if (!decisionPricing) return null;
    const estimate =
      ((Buffer.byteLength(JSON.stringify(frozenDecision(request))) + 16384) *
        2 *
        decisionPricing.prompt +
        28800 * decisionPricing.completion +
        decisionPricing.request) *
      1.2;
    return Number.isFinite(estimate) ? estimate : null;
  };
  const settleContext = async () => {
    await idle;
    await current?.decision?.completion;
    if (!current?.context || current.settled) return;
    try {
      for (const record of records.filter((record) => record.attemptId === current.id)) {
        if (record.forwarded !== false) continue;
        record.accountingStatus = "not_forwarded";
        Object.assign(
          ledger.entries.find((entry) => entry.id === record.id),
          {
            accountingStatus: "not_forwarded",
            forwarded: false,
          },
        );
      }
      await persist(current.preparedRecord, "reconciliation");
      for (const record of records.filter((record) => record.attemptId === current.id))
        await retain(record);
      current.settled = true;
    } catch (error) {
      blocked = true;
      throw new Error(redact(String(error.message)));
    }
  };
  const server = createServer(async (request, response) => {
    const send = (status, value) => {
      if (response.headersSent || response.destroyed) return;
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(safe(value)));
    };
    const path = new URL(request.url, "http://evaluation").pathname.replace(/^\/api\/v1/, "");
    if (request.method === "POST" && path === "/api/alpha/decisions") {
      const decision = current?.decision;
      if (!contextPlanning)
        return send(404, { error: { message: "Context planning is disabled" } });
      if (closed || blocked || busy || !decision || decision.used || current.used)
        return send(409, {
          error: { message: "Decision call is not registered or was already attempted" },
        });
      decision.used = true;
      const finished = Promise.withResolvers();
      decision.completion = finished.promise;
      const record = decision.record,
        started = performance.now();
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 32768) throw new Error("Decision request exceeds its evidence limit");
          chunks.push(chunk);
        }
        const body = frozenDecision(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (!isDeepStrictEqual(body, decision.request))
          throw new Error("Decision differs from its frozen instruction");
        record.request = safe(body);
        record.forwarded = true;
        const result = await fetchImpl("https://openrouter.ai/api/alpha/decisions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "X-OpenRouter-Cache": "false",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(45000),
        });
        record.status = result.status;
        record.responseCacheHit = [...result.headers].some(
          ([key, value]) => key.includes("cache") && /(^|[ ,;])hit([ ,;]|$)/i.test(value),
        );
        const payload = await result.json();
        record.response = safe(payload);
        record.usage = safe(payload.usage ?? null);
        record.observedIdentity = {
          model: payload.model ?? null,
          provider: payload.provider ?? null,
          generationId: payload.id ?? null,
          serviceTier: payload.service_tier ?? null,
        };
        record.identityValid =
          [decisionModel, "typesafe/jev-1.13-20260917"].includes(payload.model) &&
          payload.provider === "TypeSafe" &&
          typeof payload.id === "string" &&
          payload.id.startsWith("gen-dec-") &&
          (payload.service_tier == null || ["standard", "default"].includes(payload.service_tier));
        record.decisionValid =
          record.identityValid &&
          !record.responseCacheHit &&
          result.ok &&
          isDeepStrictEqual(Object.keys(payload.answers ?? {}).sort(), ["appearance", "layout"]) &&
          ["appearance", "layout"].every(
            (key) =>
              payload.answers[key]?.type === "noul" &&
              Number.isFinite(payload.answers[key].noul) &&
              payload.answers[key].noul >= 0 &&
              payload.answers[key].noul <= 1,
          );
        if (Number.isFinite(payload.usage?.cost) && payload.usage.cost >= 0) {
          record.reportedUsd = payload.usage.cost;
          decision.reservation.reportedUsd = payload.usage.cost;
        } else record.accountingWarning = "Provider charge is unavailable";
        if (!record.decisionValid) {
          record.error = "Jev response does not match the frozen decision contract";
          send(502, { error: { message: record.error } });
        } else send(result.status, payload);
      } catch (error) {
        record.error = safe(String(error.message));
        send(502, { error: { message: record.error } });
      } finally {
        record.elapsedMs = performance.now() - started;
        try {
          await retain(record);
        } catch {
          blocked = true;
        }
        finished.resolve();
      }
      return;
    }
    const metadataProfile = configured.find((profile) => profile.endpointPath === path);
    if (request.method === "GET" && metadataProfile)
      return send(
        metadataProfile.metadata ? 200 : 503,
        metadataProfile.metadata ?? { error: "Pricing unavailable" },
      );
    if (request.method !== "POST" || path !== "/chat/completions")
      return send(404, { error: { message: "Unknown evaluation provider route" } });
    if (
      closed ||
      blocked ||
      busy ||
      !current ||
      current.used ||
      (current.decision && !current.decision.used)
    )
      return send(409, {
        error: {
          message:
            "Inference blocked: missing attempt, retry, concurrent call or prior provider failure",
        },
      });
    current.used = true;
    busy = true;
    const finished = Promise.withResolvers();
    idle = finished.promise;
    const started = performance.now();
    const record = current.preparedRecord ?? newRecord();
    let reservation = current.reservation;
    let receivingProvider = false;
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
      if (
        current.preparedRequests
          ? !current.preparedRequests.some((prepared) => isDeepStrictEqual(body, prepared))
          : current.preparedRequest && !isDeepStrictEqual(body, current.preparedRequest)
      )
        throw new Error("Inference differs from its frozen prepared request; no paid call made");
      record.request = safe(body);
      const text = JSON.stringify(body);
      // UTF-8 bytes plus framing bound text tokenization; no image/audio inputs are allowed.
      const maximum = maximumCharge(body, pricing);
      if (!reservation) await reserve(record, maximum);
      reservation = current.reservation;
      record.forwarded = true;
      receivingProvider = true;
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
      receivingProvider = false;
      record.status = result.status;
      record.headers = Object.fromEntries(
        [...result.headers].filter(([key]) =>
          /^(x-openrouter-|x-generation-id$|x-request-id$|retry-after$|cache-control$|age$)/i.test(
            key,
          ),
        ),
      );
      record.responseReuseDisabled = true;
      await retain(record);
      receivingProvider = true;
      const responseText = await result.text();
      receivingProvider = false;
      record.response = safe(responseText);
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
        [profile.provider.split("/")[0], profile.endpoint.provider_name].some(
          (provider) =>
            typeof provider === "string" &&
            provider.toLowerCase().replace(/[^a-z0-9]/g, "") ===
              payload.provider.toLowerCase().replace(/[^a-z0-9]/g, ""),
        );
      record.responseCacheHit = Object.entries(record.headers).some(
        ([key, value]) => key.includes("cache") && /(^|[ ,;])hit([ ,;]|$)/i.test(value),
      );
      const cost = payload.usage?.cost;
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        reservation.reportedUsd = cost;
        record.reportedUsd = cost;
      }
      if (reservation.reportedUsd == null)
        record.accountingWarning = "Provider charge is unavailable";
      if (profile.strict && (!record.identityValid || record.responseCacheHit)) {
        blocked = true;
        record.error =
          "Provider identity mismatch or response cache hit; further qualification calls are blocked";
      }
      if (!blocked) {
        record.responseElapsedMs = performance.now() - started;
        send(result.status, payload);
      }
      if (!current.context) await persist(record, "reconciliation");
      record.elapsedMs = performance.now() - started;
      await retain(record);
      send(result.status, payload);
    } catch (error) {
      blocked ||= current.reservation != null && !receivingProvider;
      record.error = safe(String(error.message));
      const generationId = record.headers?.["x-generation-id"];
      if (!current.context && current.reservation && record.reportedUsd == null && generationId) {
        record.chargeRecovery = { generationId, status: null };
        try {
          const recovery = await fetchImpl(
            `${upstream}/generation?id=${encodeURIComponent(generationId)}`,
            {
              method: "GET",
              headers: { Authorization: `Bearer ${apiKey}` },
              signal: AbortSignal.timeout(10000),
            },
          );
          record.chargeRecovery.status = recovery.status;
          if (!recovery.ok) throw new Error("Generation metadata is unavailable");
          const { data } = await recovery.json();
          const profile = current.profile;
          if (
            data?.id !== generationId ||
            !profile.acceptedModels.includes(data.model) ||
            ![profile.provider, profile.endpoint.provider_name].some(
              (provider) =>
                typeof provider === "string" &&
                provider.toLowerCase() === data.provider_name?.toLowerCase(),
            ) ||
            !Number.isFinite(data.total_cost) ||
            data.total_cost < 0
          )
            throw new Error("Generation metadata does not verify the reserved charge");
          record.reportedUsd = data.total_cost;
          record.reportedCostSource = "generation";
          current.reservation.reportedUsd = data.total_cost;
          await persist(record, "reconciliation");
        } catch (recoveryError) {
          record.chargeRecovery.error = safe(String(recoveryError.message));
        }
      }
      record.elapsedMs = performance.now() - started;
      try {
        await retain(record);
      } catch {
        blocked = true;
      }
      send(current.reservation ? 502 : 400, { error: { message: record.error } });
    } finally {
      busy = false;
      finished.resolve();
    }
  });
  return {
    server,
    records,
    accountingWarnings,
    pricing: configured[0].pricing,
    profiles: configured,
    contextPlanningMetadata: decisionMetadata ?? null,
    forecastDecision(request) {
      if (!contextPlanning) throw new Error("Context planning is disabled");
      return { maximumUsd: decisionEstimate(frozenDecision(request)), pricing: decisionPricing };
    },
    forecastRequests(requests) {
      if (
        !Array.isArray(requests) ||
        !requests.length ||
        new Set(requests.map((r) => r.id)).size !== requests.length
      )
        throw new Error("Forecast requires unique planned request identities");
      const reservations = requests.map(({ id, profileId, request }) => {
        const profile = configured.find((p) => p.id === profileId);
        if (!profile || typeof id !== "string" || !id)
          throw new Error("Invalid forecast profile or identity");
        const body = boundedRequest(request, profile);
        const estimate = maximumCharge(body, profile.pricing);
        const maximumUsd = estimate === null ? null : estimate * 1.1;
        return {
          id,
          profileId,
          maximumUsd: Number.isFinite(maximumUsd) ? maximumUsd : null,
          preparedBytes: Buffer.byteLength(JSON.stringify(body)),
        };
      });
      const projectedUsd = reservations.some((r) => r.maximumUsd == null)
        ? null
        : reservations.reduce((sum, r) => sum + r.maximumUsd, 0);
      const remainingUsd = this.budget.remainingUsd;
      return {
        basis:
          "Sum of prepared request byte/token reservation ceilings with 10% allocation headroom; estimates are informational",
        reservations,
        projectedUsd,
        remainingUsd,
        fits: null,
      };
    },
    get budget() {
      const spentUsd = ledger.entries.reduce(
        (sum, entry) =>
          sum +
          (entry.accountingStatus === "not_forwarded"
            ? 0
            : (entry.reportedUsd ?? entry.reservedUsd ?? 0)),
        0,
      );
      const unknown = ledger.entries.filter(
        (entry) => entry.reportedUsd == null && entry.accountingStatus !== "not_forwarded",
      );
      return {
        budgetPolicy,
        ceilingUsd: null,
        remainingUsd: null,
        spentUsd: unknown.some((entry) => entry.reservedUsd == null) ? null : spentUsd,
        knownReportedUsd: ledger.entries.reduce((sum, entry) => sum + (entry.reportedUsd ?? 0), 0),
        unknownChargeRecords: unknown.length,
        notForwardedRecords: ledger.entries.filter(
          (entry) => entry.accountingStatus === "not_forwarded",
        ).length,
        unknownReservedUsd: unknown.reduce((sum, entry) => sum + (entry.reservedUsd ?? 0), 0),
        unknownEstimateRecords: unknown.filter((entry) => entry.reservedUsd == null).length,
        pendingCharges: unknown.length,
      };
    },
    beginAttempt(id, profileId = configured[0].id, maximumUsd = Infinity, preparedRequest) {
      const profile = configured.find((item) => item.id === profileId);
      if (!profile) throw new Error("Unknown inference profile");
      if (
        maximumUsd !== null &&
        (!(maximumUsd >= 0) || (maximumUsd !== Infinity && !Number.isFinite(maximumUsd)))
      )
        throw new Error("Invalid frozen request allocation");
      if (
        closed ||
        blocked ||
        busy ||
        current?.preparedRecord ||
        typeof id !== "string" ||
        !id ||
        attempts.has(id)
      )
        throw new Error("Cannot begin an overlapping, repeated or blocked inference attempt");
      const frozenRequest =
        preparedRequest == null ? null : structuredClone(boundedRequest(preparedRequest, profile));
      attempts.add(id);
      current = { id, profile, used: false, maximumUsd, preparedRequest: frozenRequest };
    },
    async reserveAttempt(id, profileId, maximumUsd, context) {
      if (maximumUsd !== null && (!Number.isFinite(maximumUsd) || maximumUsd < 0))
        throw new Error("Prepared attempt requires a finite frozen allocation");
      let preparedRequests, decisionRequest, preparedRequest;
      if (object(context) && Object.hasOwn(context, "preparedRequest")) {
        if (Object.keys(context).length !== 1 || !object(context.preparedRequest))
          throw new Error("Ordinary preparation requires exactly one frozen request");
        preparedRequest = context.preparedRequest;
        context = null;
      }
      if (context != null) {
        if (
          !contextPlanning ||
          !object(context) ||
          Object.keys(context).some(
            (key) => !["preparedRequests", "decisionRequest"].includes(key),
          ) ||
          !Array.isArray(context.preparedRequests) ||
          context.preparedRequests.length < 1 ||
          context.preparedRequests.length > 4
        )
          throw new Error("Context evaluation requires one to four frozen chat requests");
        const profile = configured.find((item) => item.id === profileId);
        if (!profile) throw new Error("Unknown inference profile");
        preparedRequests = context.preparedRequests.map((request) =>
          structuredClone(boundedRequest(request, profile)),
        );
        if (context.decisionRequest) {
          decisionRequest = frozenDecision(context.decisionRequest);
          if (
            !preparedRequests.every((request) => {
              try {
                return (
                  JSON.parse(request.messages.find((message) => message.role === "user").content)
                    .instruction === decisionRequest.state
                );
              } catch {
                return false;
              }
            })
          )
            throw new Error("Jev state must equal the original prepared LLM instruction");
        }
      }
      this.beginAttempt(id, profileId, maximumUsd, preparedRequest);
      busy = true;
      const finished = Promise.withResolvers();
      idle = finished.promise;
      current.preparedRecord = newRecord();
      try {
        if (context != null) {
          current.context = true;
          current.preparedRequests = preparedRequests;
          Object.assign(current.preparedRecord, {
            kind: "chat",
            forwarded: false,
            reservedUsd: maximumUsd,
          });
          reserveCharge(ledger, maximumUsd, current.preparedRecord.id);
          current.reservation = ledger.entries.at(-1);
          Object.assign(current.reservation, { attemptId: id, kind: "chat" });
          if (decisionRequest) {
            const record = newRecord(),
              maximum = decisionEstimate(decisionRequest);
            Object.assign(record, {
              kind: "decision",
              forwarded: false,
              reservedUsd: maximum,
              pricing: decisionPricing,
              requestedIdentity: { model: decisionModel, provider: "typesafe" },
            });
            reserveCharge(ledger, maximum, record.id);
            const reservation = ledger.entries.at(-1);
            Object.assign(reservation, { attemptId: id, kind: "decision" });
            current.decision = {
              request: decisionRequest,
              record,
              reservation,
              used: false,
              completion: Promise.resolve(),
            };
          }
          await persist(current.preparedRecord, "reservation");
          for (const record of records.filter((record) => record.attemptId === id))
            await retain(record);
        } else await reserve(current.preparedRecord, maximumUsd);
      } catch (error) {
        blocked = true;
        throw new Error(redact(String(error.message)));
      } finally {
        busy = false;
        finished.resolve();
      }
    },
    async finishAttempt() {
      await idle;
      await settleContext();
      if (!current?.preparedRecord) throw new Error("No prepared attempt to finish");
      if (blocked)
        throw new Error("Prepared attempt evidence or inference failed; further calls blocked");
      current.preparedRecord = null;
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
        await settleContext();
        if (lockOwned) await rm(lock, { recursive: true }).catch((error) => warn(error));
      })();
      return closing;
    },
  };
}
