# Routes for a small model screening experiment

Public primary sources checked on 2026-09-30. No credentials, inference requests or paid calls were used. This is route research, not measured xpathed accuracy or latency. The user's priority is speed, then performance, then cost; cheap-only routing is not the objective.

The maintainer subsequently excluded paid fast/priority tiers from the experiment. Use the three standard routes only. Premium prices below remain research evidence, not selected configurations or automatic upgrade options. Cost remains a selection constraint alongside speed and correctness.

## Verified shortlist

The public OpenRouter catalog currently exposes these three exact IDs. Its canonical slugs identify the observed revisions; save both requested and returned identities in each run because alias availability can change. [Public model catalog](https://openrouter.ai/api/v1/models)

| Requested model ID             | Observed canonical slug                 | Context tokens | Reasoning advertised by catalog                                        |
| ------------------------------ | --------------------------------------- | -------------: | ---------------------------------------------------------------------- |
| `openai/gpt-6-luna`            | `openai/gpt-6-luna-20260922`            |      1,050,000 | Optional; default medium; supports none, low, medium, high, xhigh, max |
| `google/gemini-3.8-flash`      | `google/gemini-3.8-flash-20260902`      |      1,048,576 | Mandatory; default medium; supports low, medium, high                  |
| `deepseek/deepseek-v4.1-flash` | `deepseek/deepseek-v4.1-flash-20260910` |      1,048,576 | Optional; default high; supports low, high, max                        |

V4.1 Flash was the newest DeepSeek Flash model in the catalog at inspection. Do not substitute the older V4 Flash or experimental vision release, and do not use an unversioned latest alias for an experiment. These large context limits are capability metadata, not a reason to send large DOMs.

## Candidate provider routes and prices

USD per million uncached text input / billed completion tokens. Values below come directly from endpoint `pricing.prompt` and `pricing.completion`, multiplied by one million; do not apply the separately returned `discount` field a second time. No tools, images or searches are needed for this workload.

| Model               | Exact provider tag          |  Input / output | Cached input | Endpoint completion limit |
| ------------------- | --------------------------- | --------------: | -----------: | ------------------------: |
| GPT-6 Luna          | `openai`                    |   $0.10 / $0.50 |        $0.01 |                   128,000 |
| GPT-6 Luna          | `openai/fast`               |   $0.20 / $1.00 |        $0.02 |                   128,000 |
| Gemini 3.8 Flash    | `google-ai-studio`          |   $0.75 / $3.75 |       $0.075 |                    65,536 |
| Gemini 3.8 Flash    | `google-ai-studio/priority` |   $1.35 / $6.75 |       $0.135 |                    65,536 |
| DeepSeek V4.1 Flash | `wafer`                     | $0.0749 / $0.70 |       $0.045 |                   943,718 |

Sources: [Luna endpoints](https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints), [Gemini endpoints](https://openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints), [DeepSeek endpoints](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints).

All five listed routes advertised `response_format`, `structured_outputs`, `max_tokens` and reasoning support, and had endpoint status `0` at inspection. This confirms advertised compatibility, not that xpathed's exact schema has passed a live request. Luna did not advertise `temperature`; do not send a common temperature setting indiscriminately. Its listed rates also have a higher-price override beginning at 272,000 input tokens, outside the examples below. Gemini separately lists internal reasoning at its completion rate.

Native DeepSeek's `deepseek` endpoint advertised `response_format` but not `structured_outputs` and has time-dependent price overrides. It is not interchangeable with Wafer for a strict-schema experiment. Wafer is a reproducible existing comparison route, not a demonstrated speed winner. Alternate expensive routes and fast/priority tiers are excluded from the current plan.

## Configuration implications

Use a versioned experiment configuration per model and provider. Proposed first settings are Luna `reasoning.effort: "none"`, Gemini `reasoning.effort: "low"`, and DeepSeek `reasoning.enabled: false`. Gemini's mandatory reasoning means the current blanket disable setting cannot be reused for all three. Verify the selected route's actual behavior in a tiny schema smoke check before wider screening. Low reasoning is a starting point to measure, not a quality conclusion.

Hiding reasoning with `exclude: true` does not disable computation or billing. Most providers count reasoning against the completion limit; an undersized limit can produce billed reasoning and no usable JSON. Retain a bounded output allowance and grade truncated responses as failures. [OpenRouter reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)

Keep the existing strict schema and post-response validation. Set `require_parameters: true`; advertised structured-output support does not guarantee semantic correctness, and provider schema enforcement varies. [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)

Pin the provider tag and disable automatic provider fallbacks for measured comparisons. Service-tier endpoints such as `openai/fast` need an explicit tier or suffixed tag; base slugs do not opt into those tiers. OpenRouter's default strategy prioritizes price, whereas explicit latency/throughput sorting is available. Use that distinction intentionally rather than treating its default provider as fastest. [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)

## Speed evidence and measurement boundary

The inspected public endpoint records returned **null** for both `latency_last_30m` and `throughput_last_30m`. Website summaries may show rolling aggregate figures, but those are not matched measurements of these prompts. No primary evidence gathered here justifies declaring a winner.

Measure time until valid resolution output, plus the full capture/inference/verification duration. TTFT includes queueing and input prefill; output generation speed is a separate component. Large DOM input and short JSON output can make prefill more important than tokens per second. [OpenRouter latency guide](https://openrouter.ai/docs/guides/best-practices/latency-and-performance)

Proposed screening: the same small, versioned, representative development cases for every model; interleave run order; separate cold and warm cache conditions; preserve failures and first attempts. Try one baseline prompt before expanding only the promising configurations. Rank measured latency among candidates meeting an agreed minimum correctness boundary, then accuracy and cost; a fast wrong target is unusable. A 20-case screen can eliminate bad configurations but cannot establish a reliable p95 or held-out generalization. Reserve a separate untouched confirmation set and more repetitions for finalists.

## Illustrative token costs, not a forecast or spend authorization

Each cell assumes one call per case, exactly 8,000 or 32,000 uncached input tokens, and **200 total billed completion tokens**, including any reasoning. No retries, additional prompts, repetitions, tools, cache savings or account funding fees are included. Actual Gemini reasoning alone can exceed this completion assumption. These examples explain the scale of a screen, not the measured cost of the external datasets.

| Model and route             | 20 cases, 8k/200 | 20 cases, 32k/200 | 50 cases, 8k/200 | 50 cases, 32k/200 |
| --------------------------- | ---------------: | ----------------: | ---------------: | ----------------: |
| Luna / OpenAI               |          $0.0180 |           $0.0660 |          $0.0450 |           $0.1650 |
| Luna / OpenAI fast          |          $0.0360 |           $0.1320 |          $0.0900 |           $0.3300 |
| Gemini / AI Studio          |          $0.1350 |           $0.4950 |          $0.3375 |           $1.2375 |
| Gemini / AI Studio priority |          $0.2430 |           $0.8910 |          $0.6075 |           $2.2275 |
| DeepSeek / Wafer            |          $0.0148 |           $0.0507 |          $0.0370 |           $0.1268 |

Formula: `cases × (inputTokens × inputPrice + billedCompletionTokens × outputPrice) / 1,000,000`. For example, all three standard routes together cost $0.1678 for the 20-case 8k/200 illustration, or $0.6117 at 32k/200. At 30 cases per model, the corresponding totals are **$0.2517** and **$0.9176**. Each independent prompt variant and repetition multiplies that work. Reusing imported assets and deterministic replay is free of model inference charges; comparing a new model or system prompt requires new calls.

Recommended proposal for user confirmation: begin with the three standard routes, 30 shared development cases each and one baseline prompt, under a **$5 total ceiling**. This ceiling is a suggested budget, not authorization or a promise that every run fits. Start with one compatibility call per model within that same budget and forecast remaining cost from its actual input, reasoning and output usage. Fast/priority tiers should be separate versioned experiments after the initial screen, not a hidden global switch. Stop before the next request if its conservative reserved cost would exceed the remaining ceiling; keep billed failure costs in the total.

Before any paid pilot, freeze the case count, payload policy, model/provider settings and a total run ceiling; then replace these illustrative numbers with measured usage. Research has not changed the existing live-test route or authorized provider submissions.
