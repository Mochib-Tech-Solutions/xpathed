# Model availability for qualification

Checked 2026-09-30 for issue #9 against public OpenRouter APIs and official documentation. No credentials or paid inference were used. These observations refresh the older [screening route research](model-screening-routes.md); they establish advertised availability, not compatibility with our exact schema or a performance ranking.

## Verified standard routes

The public catalog returned all three requested IDs, with these canonical revisions. V4.1 Flash was the newest explicitly versioned DeepSeek Flash text model in the catalog. Store the requested ID and observed revision separately; do not replace it with a moving latest alias. [OpenRouter catalog](https://openrouter.ai/api/v1/models)

| Requested model ID             | Observed canonical slug                 | Standard provider tag | USD per million input / output tokens |
| ------------------------------ | --------------------------------------- | --------------------- | ------------------------------------: |
| `openai/gpt-6-luna`            | `openai/gpt-6-luna-20260922`            | `openai`              |                         $0.10 / $0.50 |
| `google/gemini-3.8-flash`      | `google/gemini-3.8-flash-20260902`      | `google-ai-studio`    |                         $0.75 / $3.75 |
| `deepseek/deepseek-v4.1-flash` | `deepseek/deepseek-v4.1-flash-20260910` | `wafer`               |                       $0.0749 / $0.44 |

Prices are the endpoint's `pricing.prompt` and `pricing.completion` multiplied by one million, for uncached text and billed completion tokens. Sources: [Luna endpoints](https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints), [Gemini endpoints](https://openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints), [DeepSeek endpoints](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints).

All three selected endpoints reported `status: 0`, `response_format`, `structured_outputs`, `reasoning` and `max_tokens`. Luna did not advertise `temperature`; avoid an unconditional shared temperature parameter. Its price increases beginning at 272,000 prompt tokens, beyond the intended compact DOM workload. The Gemini endpoint additionally lists reasoning at its completion rate and a separate `discount` field; do not multiply the returned prices by that discount again. Wafer's output price is now $0.44, compared with $0.70 in the earlier note: refresh endpoint metadata before reserving budget rather than copying dated rates. [Luna endpoints](https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints), [Gemini endpoints](https://openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints), [DeepSeek endpoints](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints)

## Request settings

The catalog advertises optional Luna reasoning with `none` supported; mandatory Gemini reasoning with `low`, `medium` and `high`; and optional DeepSeek reasoning. Proposed baseline settings remain Luna `reasoning.effort: "none"`, Gemini `reasoning.effort: "low"`, and DeepSeek `reasoning.enabled: false`. Gemini cannot share a universal disable setting. [OpenRouter catalog](https://openrouter.ai/api/v1/models)

`reasoning.exclude: true` hides reasoning text rather than disabling computation. Reasoning generally consumes the completion allowance; `finish_reason: "length"` can leave empty visible output while still billing tokens. Preserve output limits, usage and truncation as observable failures. [Reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)

Pin the selected standard provider, disable fallback, and require parameter support. Exclude fast, priority and flex tiers from this experiment. Account restrictions can still make a publicly listed route unavailable, so public metadata is not an authenticated compatibility test. [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)

Use strict JSON schema plus local contract validation, including selected candidate IDs and action consistency. OpenRouter recommends `provider.require_parameters: true` with `response_format.type: "json_schema"`; advertised structured outputs cannot establish correct target selection. [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)

## Fresh inference and cache evidence

Set `X-OpenRouter-Cache: false` on every measured request. Preserve response cache status/source headers and usage, and reject response cache hits as fresh inference evidence. OpenRouter assigns a unique generation ID even to a cache hit, so ID uniqueness alone is insufficient. Cached responses have zero billable usage. A missing cache-status header does not itself prove a hit or a miss. [Response caching](https://openrouter.ai/docs/guides/features/response-caching)

Provider prompt caching is separate: reused prompt computation can still produce newly generated output. Record cached and cache-write token counts and distinguish observed cache conditions in latency reports. For Luna, `prompt_cache_options: { "mode": "explicit" }` without breakpoints disables automatic prompt caching and avoids its cache-write charge. Gemini supports implicit caching; do not claim all requests are cold merely because no explicit cache blocks were sent. [Prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)

## Remaining decisions and limits

No replacement model is needed on present public evidence. If a route disappears, fails the exact-schema compatibility check, or changes revision, stop and record that outcome; do not silently substitute a cheaper model or premium tier. A replacement would change the experiment and needs an explicit decision.

Keep compatibility calls inside the existing shared experiment ceiling, reconcile charged failures, and freeze settings before held-out qualification. This research authorizes no additional spend and proposes no default promotion. Public endpoint latency and throughput fields were null for the three selected routes at inspection; qualification must use measured workload results. A listed model, valid schema, or successful pilot alone does not establish an approved resolver release.
