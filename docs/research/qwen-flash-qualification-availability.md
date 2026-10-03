# Qwen3.8 Flash qualification availability

Checked 2026-10-01 against public OpenRouter APIs and official documentation. No credentials or paid inference were used. This establishes advertised compatibility; exact-schema behavior and end-to-end speed require the recorded live experiment.

## Observed route

The catalog maps requested ID `qwen/qwen3.8-flash` to canonical revision `qwen/qwen3.8-flash-20260826`. It advertises optional reasoning (`mandatory: false`), enabled by default, with token-budget support. This supports requesting reasoning off; it does not prove how an authenticated request will be served. [Model catalog](https://openrouter.ai/api/v1/models)

The Alibaba endpoint (`tag: alibaba`) reports `status: 0`, `structured_outputs`, `response_format`, `reasoning` and `max_tokens`. Its limits are 1,000,000 context tokens, 983,616 prompt tokens and 131,072 completion tokens. Public latency and throughput fields are null. [Endpoint metadata](https://openrouter.ai/api/v1/models/qwen/qwen3.8-flash/endpoints)

| Advertised charge | USD per million tokens |
| ----------------- | ---------------------: |
| Uncached input    |                  $0.15 |
| Completion        |                  $0.47 |
| Cache read        |                 $0.016 |
| Cache write       |                  $0.20 |

These are endpoint rates multiplied by one million. No separate long-context price tiers or reasoning surcharge were exposed in this snapshot. Refresh metadata when reserving budget; reported charges remain authoritative. [Endpoint metadata](https://openrouter.ai/api/v1/models/qwen/qwen3.8-flash/endpoints)

## Recommended experiment settings

Reuse the existing baseline request and 4,096-token completion ceiling. Set `reasoning: { "enabled": false }`, pin `provider.only: ["alibaba"]`, disable fallback, require parameter support and retain strict JSON schema plus local contract validation. Use standard serving without a premium variant. These are experiment choices, not evidence of successful compatibility. [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)

Do not substitute `reasoning.exclude: true`: that hides reasoning without disabling its computation or charges. Reasoning generally shares the completion allowance. Confirm actual reasoning usage, finish reason, model/provider identity and full contract output during the pilot; preserve rejected or truncated responses as failures. [Reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)

Set `X-OpenRouter-Cache: false` and retain cache-status evidence. Unique generation IDs alone do not establish fresh inference because response-cache hits receive new IDs. [Response caching](https://openrouter.ai/docs/guides/features/response-caching)

The Qwen endpoint advertises `supports_implicit_caching: true`, while the generic Alibaba documentation describes explicit breakpoints and does not list this revision. Do not infer cold prompts from the absence of breakpoints or add OpenAI-specific cache controls. Record cache read/write tokens and describe prompt-cache warmth as uncontrolled. [Endpoint metadata](https://openrouter.ai/api/v1/models/qwen/qwen3.8-flash/endpoints), [prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)

The sub-second goal and two-second deadline must be measured on complete correct resolutions, including capture and validation. Public model labels, parameter count and pricing provide no evidence that this workload meets either target. Keep the existing shared $5 ledger, preserve capability gaps and stop on route/schema incompatibility rather than silently changing provider or model. Adding this evaluation profile does not promote a production default.

For the separately requested external-dataset comparison, use one identical baseline system prompt, schema and candidate payload per case across models, with one attempt per original labelled case per model. The pilot is a subset of that total; continue with disjoint remaining cases rather than repeating pilot cases. Do not include prompt variants or relabel source targets from model outcomes. Saved-page selection timing excludes live capture and XPath/readiness verification, so report it separately from browser resolution latency.
