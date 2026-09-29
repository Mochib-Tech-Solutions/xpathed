# OpenRouter route for instruction resolution

Checked 2026-09-29. This is implementation research for [issue #3](https://github.com/Mochib-Tech-Solutions/xpathed/issues/3), following [ADR-0002](../adr/0002-select-elements-before-generating-xpath.md) and [ADR-0004](../adr/0004-qualify-complete-resolver-releases.md). Public catalog requests succeeded without authentication. No credentials were read and no inference request was made. An authenticated resolver smoke check is still required; this note does not qualify a release or establish speed or accuracy.

## Recommended first route

Use `openai/gpt-6-luna` through the `openai` endpoint on `POST https://openrouter.ai/api/v1/chat/completions`, with reasoning disabled. The public catalog lists this model and its endpoint advertises JSON schema support. Its standard input/output price is $0.10/$0.50 per million tokens below the long-input tier; the selected endpoint has a 1,050,000-token context, 922,000 maximum prompt tokens and 128,000 maximum completion tokens. Those are provider limits, not sensible application budgets. [Endpoint catalog](https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints)

The model catalog reports `none`, `low`, `medium`, `high`, `xhigh`, and `max` reasoning efforts, with `medium` default. OpenAI's model card independently documents `none` and structured outputs. Set the effort explicitly. [Model catalog](https://openrouter.ai/api/v1/models), [OpenAI model card](https://developers.openai.com/api/docs/models/gpt-6-luna)

The other shortlisted IDs also appeared in the public catalog: `google/gemini-3.8-flash` and `deepseek/deepseek-v4.1-flash`. They are unnecessary for the first route check. Their endpoint capabilities and prices differ; the old shortlist's prices must not be reused as a current quote. [Model catalog](https://openrouter.ai/api/v1/models)

## Exact gateway settings

Send bearer authentication from server configuration. Use non-streaming Chat Completions initially; no SDK dependency is required for this HTTP/JSON contract. [API reference](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request)

```http
POST /api/v1/chat/completions
Host: openrouter.ai
Authorization: Bearer <server-configured-key>
Content-Type: application/json
X-OpenRouter-Cache: false
X-OpenRouter-Metadata: enabled
```

The following is the settings fragment; add the sanitized `messages` and the application's strict `response_format` schema:

```json
{
  "model": "openai/gpt-6-luna",
  "stream": false,
  "service_tier": "default",
  "max_tokens": 512,
  "reasoning": { "effort": "none" },
  "provider": {
    "only": ["openai"],
    "order": ["openai"],
    "allow_fallbacks": false,
    "require_parameters": true
  },
  "plugins": [{ "id": "context-compression", "enabled": false }]
}
```

`512` is a proposed starting completion budget to test, not a provider requirement. Omit `temperature`: it is absent from this endpoint's advertised parameters. OpenRouter's normalized `reasoning.effort: "none"` disables reasoning; `exclude: true` merely hides reasoning and still consumes tokens. [Reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)

`only` restricts the eligible provider, `order` fixes preference, and disabling fallback prevents a silent route change. Base slugs normally include provider variants, but service-tier endpoints are excluded unless explicitly requested. Thus `openai` with `service_tier: "default"` does not admit `openai/flex` or `openai/fast`. Recheck the endpoint list when qualifying a different configuration. [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [Service tiers](https://openrouter.ai/docs/guides/features/service-tiers)

Use `response_format: {"type":"json_schema","json_schema":{"name":"target_selection","strict":true,"schema":...}}`. The local schema should require every field and prohibit additional properties; validate the resulting selection again in application code. Endpoint schema support alone does not establish semantic accuracy. `require_parameters` filters for endpoint support. [Structured output](https://openrouter.ai/docs/guides/features/structured-outputs)

Disable context compression because it can discard candidate-bearing messages; exceeding the budget must fail. Keep response healing and model tools absent so original output failures remain observable and page instructions cannot execute. Gateway response caching is explicitly disabled for the live check; provider prompt caching remains separate. [Compression](https://openrouter.ai/docs/guides/features/message-transforms), [Response caching](https://openrouter.ai/docs/guides/features/response-caching)

## Response handling and evidence

Check HTTP status, top-level `error`, and choice-level `error` before parsing content. A non-streaming HTTP 200 can still carry an error. Preserve authentication, rate limit, timeout, refusal, empty response, malformed JSON and truncation as operational outcomes. Inspect `error.metadata.error_type`, `message.refusal`, and `finish_reason`; `length` is truncation, even when content is empty. Error messages and metadata can contain input excerpts, so retain safe codes rather than logging their raw bodies. [Error contract](https://openrouter.ai/docs/api_reference/errors-and-debugging)

Record `id`, returned `model`, provider, `service_tier`, finish reason, and local elapsed time. Opt-in `openrouter_metadata` exposes selected endpoint candidates, attempts and transformations. Unknown optional fields can be ignored; missing metadata must remain unavailable. For the live check, inspect it for the selected OpenAI provider and unexpected compression/healing or fallbacks. [Routing metadata](https://openrouter.ai/docs/guides/features/router-metadata)

Usage is returned automatically. Read `usage.prompt_tokens`, `completion_tokens`, `total_tokens`, `completion_tokens_details.reasoning_tokens`, `prompt_tokens_details.cached_tokens`, and `cost` when supplied. Preserve null for unavailable values rather than inventing zero. The old `usage.include` flag is deprecated. [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)

The generation ID can retrieve provider/model identity, native token counts, timing, upstream ID and total cost from `GET /api/v1/generation?id=...`. This is useful evidence after the smoke check, without adding another model call. [Generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-generation)

The authenticated smoke check must exercise the resolver with a known target and genuine absence, verify candidate membership and the selected node's XPath, and save safe route/usage evidence. Deterministic tests must separately cover fabricated IDs and all provider failures required by #3. A successful catalog request proves advertised availability only; account access, actual inference, instruction accuracy and latency remain unverified here.

## Saved public endpoint evidence

Selected fields from an unauthenticated GET, fetched at the timestamp below. Pricing fields are dollars per token. The `min_prompt_tokens` override changes the price above the long-input threshold.

```json
{
  "checked_at_utc": "2026-09-29T22:42:35+00:00",
  "model_id": "openai/gpt-6-luna",
  "endpoint_name": "OpenAI | openai/gpt-6-luna-20260922",
  "tag": "openai",
  "provider_name": "OpenAI",
  "context_length": 1050000,
  "max_prompt_tokens": 922000,
  "max_completion_tokens": 128000,
  "supported_parameters": [
    "reasoning",
    "include_reasoning",
    "seed",
    "max_tokens",
    "response_format",
    "structured_outputs",
    "tools",
    "tool_choice",
    "reasoning_effort"
  ],
  "pricing": {
    "prompt": "0.0000001",
    "completion": "0.0000005",
    "web_search": "0.01",
    "input_cache_read": "0.00000001",
    "input_cache_write": "0.000000125",
    "discount": 0,
    "overrides": [
      {
        "min_prompt_tokens": 272000,
        "prompt": "0.0000002",
        "completion": "0.00000075",
        "input_cache_read": "0.00000002",
        "input_cache_write": "0.00000025"
      }
    ]
  }
}
```
