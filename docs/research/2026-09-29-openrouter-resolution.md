# OpenRouter route for instruction resolution

Updated 2026-09-30 for [issue #3](https://github.com/Mochib-Tech-Solutions/xpathed/issues/3), following [ADR-0002](../adr/0002-select-elements-before-generating-xpath.md) and [ADR-0004](../adr/0004-qualify-complete-resolver-releases.md). The user prioritized inexpensive, fast testing. This note combines public catalog research and official documentation with the authorized two-request live check below. Public research read no credentials. The live check verifies authenticated access and the two fixture outcomes; it does not qualify production speed or general instruction accuracy.

## Current route

Use `deepseek/deepseek-v4.1-flash`, pinned to provider tag `wafer`, on `POST https://openrouter.ai/api/v1/chat/completions`. At 2026-09-30 06:38:30 UTC, that endpoint advertised `structured_outputs`, `response_format`, `reasoning` and `max_tokens`. Its price was **$0.0539/M input and $0.44/M output**, with $0.0431/M cache reads. Context was 1,048,576 tokens; maximum completion was 943,718 and maximum prompt tokens was unspecified. These provider limits do not replace the application's much smaller budgets. [Endpoint catalog](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints)

The model catalog reports reasoning as optional but enabled by default, with supported efforts `max`, `high` and `low`; `none` is absent. Send `reasoning: {"enabled": false}` instead of copying Luna's effort setting. Hiding reasoning with `exclude` does not stop its computation or billing. [Model catalog](https://openrouter.ai/api/v1/models), [Reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)

Wafer is a practical inexpensive route to test, not a demonstrated fastest provider. Current endpoint API fields `latency_last_30m` and `throughput_last_30m` were null. OpenRouter's indexed provider table, crawled six days earlier, showed Wafer P50 latency about 1.09 seconds and throughput 74 tokens/second, versus OpenInference about 3.14 seconds and 9 tokens/second. Those historical aggregates span other workloads and reasoning settings. They do not predict nonreasoning fixture latency; the measured live results below are specific to this run. [Provider table](https://openrouter.ai/deepseek/deepseek-v4.1-flash/providers)

The current cheapest input route, Relace ($0.02/M input, $0.60/M output), lacked both JSON and schema support. OpenInference `open-inference/fp4` supported schema at $0.03/M input and $0.50/M output; it can be cheaper depending on the input/output ratio, but the older speed figures above make it a weaker first test for this latency priority. These comparisons use endpoint prices rather than the model page's headline minimum. [Endpoint catalog](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints)

## Exact gateway settings

Use server-side bearer authentication and these headers:

```http
POST /api/v1/chat/completions
Host: openrouter.ai
Authorization: Bearer <server-configured-key>
Content-Type: application/json
X-OpenRouter-Cache: false
X-OpenRouter-Metadata: enabled
```

Add the sanitized `messages` and the application's `response_format` schema to this settings fragment:

```json
{
  "model": "deepseek/deepseek-v4.1-flash",
  "stream": false,
  "max_tokens": 512,
  "reasoning": { "enabled": false },
  "provider": {
    "only": ["wafer"],
    "order": ["wafer"],
    "allow_fallbacks": false,
    "require_parameters": true,
    "max_price": { "prompt": 0.06, "completion": 0.45, "request": 0 }
  },
  "plugins": [{ "id": "context-compression", "enabled": false }]
}
```

The price ceilings are dollars per million prompt/completion tokens; `request` caps a per-request charge. OpenRouter rejects routing when no eligible endpoint meets the ceilings. This preserves the intended spending limit if prices rise. The fixed provider and disabled fallback preserve route identity. [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)

Use `response_format: {"type":"json_schema","json_schema":{"name":"target_selection","strict":true,"schema":...}}`, requiring every field and prohibiting extra properties. `require_parameters` filters for endpoint support, while local validation still rejects malformed or inconsistent selections. Provider schema support does not establish semantic accuracy. [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)

Omit tools, response healing, temperature and service-tier overrides. Keep context compression disabled so it cannot discard candidates. Requests without tier opt-ins stay on standard endpoints. Disable response caching for the live check; provider prompt caching is separate. [Service tiers](https://openrouter.ai/docs/guides/features/service-tiers), [Compression](https://openrouter.ai/docs/guides/features/message-transforms), [Response caching](https://openrouter.ai/docs/guides/features/response-caching)

## Cost of two fixture requests

With at most 512 output tokens per request, current Wafer pricing gives:

- At most 2,000 input tokens each: **$0.00066616 total**.
- At most 5,000 input tokens each: **$0.00098956 total**.

At the configured price ceilings, the corresponding maximums are **$0.0007008** and **$0.0010608**. For an arbitrary combined input count `I`, the capped two-request cost is `I * $0.00000006 + $0.0004608`. Input counts must include the system prompt and schema as billed by the provider. These are conditional estimates, not measured token counts or a total-dollar limit enforced by `max_price`. They assume no retries or other calls and exclude credit-purchase fees. Actual usage/cost must come from the responses. [Endpoint prices](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints), [Price ceilings](https://openrouter.ai/docs/guides/routing/provider-selection)

## Response handling and live evidence

Check HTTP status, top-level `error` and choice-level `error` before content; HTTP 200 can contain an error. Preserve authentication, rate-limit, timeout, refusal, empty-response, malformed-response and truncation outcomes. Inspect `error.metadata.error_type`, `message.refusal` and `finish_reason`. Retain safe codes rather than raw errors that may quote input. [Error contract](https://openrouter.ai/docs/api_reference/errors-and-debugging)

Record returned model/provider/generation identity, finish reason, timings and available usage/cost. Missing metadata stays null. Usage is automatic; `usage.include` is deprecated. The generation endpoint can retrieve serving identity and billing after inference without another model call. [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting), [Generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-generation)

### Authenticated fixture result: 2026-09-30

The authorized live check passed with exactly **two model requests**, using standalone Browser and Resolver services without ClientApi or PostgreSQL. Both responses reported model `deepseek/deepseek-v4.1-flash`, provider `Wafer`, finish reason `stop`, zero reasoning tokens and zero cached tokens. The known target resolved to the independent fixture oracle's expected node for every returned XPath; assertions confirmed no click execution and no scrolling. The absent target returned `not_found` with no target. [Live assertions](../../tests/resolution/live.test.mjs)

| Outcome | Input / output tokens | Reported cost (USD) | Model stage (ms) | Resolver total (ms) |
| --- | --- | --- | --- | --- |
| `found` | 357 / 18 | 0.0000271623 | 1532.1878 | 1619.5251 |
| `not_found` | 367 / 19 | 0.0000281413 | 532.7566 | 545.3025 |

**Total reported cost: $0.0000553036.** Each capture scanned eight elements and fully captured two eligible candidates; both model inputs included those two candidates (559 and 605 prepared user-message bytes respectively).

The safe run log was `artifacts/live-openrouter-check.log`, result lines 162–164. Both attempts used configuration ID `b11db6cafd5cfb0460b1ee2a90fc871a4be55f44016a786feae33d322eae0107`. Generation IDs were `gen-1790750592-WjA4ioquMQ4Ay7QUeSYb` (`found`) and `gen-1790750594-7gPCg8hAJKV7wjm8gMvW` (`not_found`).

These observations establish that this configured route served the two requests and that the fixture's target/absence checks passed. They are a small smoke check, not a latency benchmark or general accuracy measurement.

## Saved public evidence

Selected fields from the unauthenticated endpoint GET; prices are dollars per token:

```json
{
  "checked_at_utc": "2026-09-30T06:38:30.839167+00:00",
  "model_id": "deepseek/deepseek-v4.1-flash",
  "endpoint_name": "Wafer | deepseek/deepseek-v4.1-flash-20260910",
  "tag": "wafer",
  "provider_name": "Wafer",
  "context_length": 1048576,
  "max_prompt_tokens": null,
  "max_completion_tokens": 943718,
  "supported_parameters_subset": ["reasoning", "max_tokens", "response_format", "structured_outputs"],
  "pricing": {
    "prompt": "0.0000000539",
    "completion": "0.00000044",
    "input_cache_read": "0.0000000431",
    "discount": 0
  },
  "latency_last_30m": null,
  "throughput_last_30m": null
}
```

## Superseded initial Luna choice

The 2026-09-29 investigation selected `openai/gpt-6-luna` through `openai`, reasoning effort `none`, standard service tier, strict schema and 512 output tokens. Its public evidence was checked at 22:42:35 UTC. The 2026-09-30 refresh still listed the standard route at $0.10/M input and $0.50/M output below 272,000 prompt tokens, with 1,050,000 context, 922,000 maximum prompt and 128,000 maximum completion tokens. This route remains catalog-supported; the user's test-cost priority supersedes it for this check. The two-request 2,000-input/512-output example would cost at most $0.000912 at those standard rates. [Luna endpoint catalog](https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints)
