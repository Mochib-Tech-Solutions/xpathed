# Fast models for target selection

Checked 2026-09-29 against official documentation and the public Zen catalog. No credentials were read and no inference requests were made. This updates the candidate shortlist in `model-evaluation-costs.md`; those earlier estimates describe different Gemini and DeepSeek configurations.

Decision after Q38: use OpenRouter only and compare models. Zen integration and gateway comparisons are out of scope. The earlier gateway comparison and Zen prices below remain research history; they do not define the implementation or the current evaluation budget. Use the OpenRouter catalog section for the chosen model IDs and verify the serving endpoint's rate before forecasting actual runs.

## Exact candidates and costs

All three explicit IDs below appear in the [Zen catalog](https://opencode.ai/zen/v1/models). Zen's documented rates are USD per million uncached input/output tokens:

| Zen model ID | Protocol | Input | Output |
| --- | --- | ---: | ---: |
| `gpt-6-luna` | Responses | $0.10 | $0.50 |
| `gemini-3.8-flash` | Gemini | $1.50 | $7.50 |
| `deepseek-v4.1-flash` | Chat Completions | $0.30 | $1.20 |

Luna's rates above apply through 272K input tokens; above that, Zen lists $0.20/$0.75. Zen also lists older `deepseek-v4-flash` separately at $0.14/$0.28. Do not assume the old and new routes have identical billing or model revisions. [Zen endpoints and pricing](https://opencode.ai/docs/zen/)

Google advertises an introductory direct Gemini 3.8 rate of $0.75/$3.75 through year end. That differs from the current Zen table; forecast the actual connection's price and reconcile usage rather than substituting Google's price into Zen estimates. [Google release guide](https://ai.google.dev/gemini-api/docs/latest-model?hl=en)

DeepSeek's own API now uses `deepseek-flash` for V4.1 Flash. Its documentation says legacy V4 Flash names are accepted but served by V4.1 Flash after retirement of the older models. This establishes alias drift on the direct service; it does not establish which upstream deployment Zen uses. Prefer the explicit `deepseek-v4.1-flash` Zen candidate and record the returned model identity when available. [DeepSeek API overview](https://api-docs.deepseek.com/)

Using the earlier illustrative 8,000-input/100-output-token scenario, one attempt over 2,000 cases costs approximately **$1.70 Luna, $25.50 Gemini 3.8, or $5.04 DeepSeek V4.1**. Across 51,663 cases: **$43.91, $658.70, or $130.19**. These are arithmetic scenarios, not measured output lengths, eligibility counts, latency, or full bills. Include billed reasoning tokens, retries and cache behavior in actual reports.

## Model limits and proposed first configurations

These are upstream model specifications. Zen endpoint compatibility still needs a small contract test before qualification.

| Model | Published capacity | Proposed initial setting | Output contract |
| --- | --- | --- | --- |
| GPT 6 Luna | 1,050,000-token context; 128,000 max output | Responses `reasoning.effort: "none"`; compare `low` if quality requires it | Strict JSON schema supported upstream |
| Gemini 3.8 Flash | 1,048,576 input tokens; 65,536 output tokens | Thinking level `low` | Structured output supported upstream |
| DeepSeek V4.1 Flash | 1M context; 384K max output | `reasoning_effort: "none"` or documented `thinking: {"type":"disabled"}`; use one clear setting | JSON object mode; application validates schema |

Luna defaults to medium reasoning. Its model card supports `none` and structured outputs. [Luna model card](https://developers.openai.com/api/docs/models/gpt-6-luna)

Gemini 3.8 supports **low, medium and high**, with medium default. **Minimal is unsupported and returns an error.** Do not copy settings from Gemini Flash Lite. Google documents low as reducing time to answer; this is guidance, not a measured result on our workload. [Gemini model specification](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), [thinking controls](https://ai.google.dev/gemini-api/docs/thinking)

DeepSeek defaults to thinking. Its current Chat Completions reference supports `reasoning_effort: "none"` to disable it. [Model limits](https://api-docs.deepseek.com/quick_start/pricing/), [request parameters](https://api-docs.deepseek.com/api/create-chat-completion/)

DeepSeek JSON mode requires `response_format: {"type":"json_object"}` and an explicit JSON instruction. It can return empty content, and a low output limit can truncate the response. Strict schema adherence is separately documented for beta tool calls using a `/beta` endpoint; do not assume Zen exposes that beta capability. [JSON output](https://api-docs.deepseek.com/guides/json_mode/), [strict tool calls](https://api-docs.deepseek.com/guides/tool_calls/)

## Contract tests before a speed comparison

Keep the output small: selected candidate ID or no-match status. Resolve XPath deterministically afterward. Recommended checks through each actual Zen adapter:

1. Exact model ID and protocol work; requested reasoning and output settings are accepted. Keep the normalized configuration and redacted request shape as evidence.
2. Unique target, scoped duplicate, off-screen target and genuine absence return valid results. Reject unknown candidate IDs and inconsistent status/ID pairs.
3. Refusal, empty output, truncation, timeout and rate limit remain operational outcomes; they must not become `not_found`.
4. Structured output fields are validated locally, even when the provider constrains generation. Do not infer semantic correctness from valid JSON.
5. Output budget accounts for reasoning where applicable. Start with a small validated budget, then tune using observed completion and truncation rates; a universal 100-token cap would be premature.
6. Record provider usage, returned model identifier and fingerprint when supplied. An accepted request does not prove an optional parameter was honored; verify documented support and observable usage where possible.

The three protocols require adapter-specific parameter mapping. Google's current examples emphasize its Interactions API, whereas Zen documents its Gemini model endpoint; do not copy an Interactions request body into the Zen route without validating its supported wire format.

## How to choose

Start the baseline with Luna at `none`, then compare Gemini at `low` and DeepSeek V4.1 without thinking on the same frozen cases and DOM representation. This order is an inexpensive initial experiment, not a speed ranking.

Measure capture, input preparation, provider round trip, response parsing and XPath validation separately; report end-to-end p50/p95 and correctness together. Use repeated interleaved runs, fixed concurrency, warm/cold distinctions and token-size buckets. Count failures and retries rather than reporting latency only for successful requests. Select the fastest configuration meeting the agreed correctness criteria.

A million-token context window prevents neither slow requests nor poor selection among distracting nodes. Keep meaningful DOM context compact, then test candidate coverage and target accuracy as input size grows. Do not introduce an extra retrieval/model call unless the baseline demonstrates a need. No measured latency, provider routing guarantee, or production default is established by this research.

## OpenRouter or Zen for evaluation?

The earlier gateway-selection research favored OpenRouter's documented controls. The user has now chosen OpenRouter only. Route controls help make comparisons between models interpretable; comparing gateways or vendors is not part of the evaluation objective.

| Need | OpenRouter | OpenCode Zen |
| --- | --- | --- |
| Model discovery | Broad catalog; API exposes pricing, context and supported parameters | Curated catalog oriented toward coding agents |
| Serving route | Explicit provider and endpoint selection, fallback controls and parameter compatibility filter | Reviewed public API docs do not establish equivalent caller controls |
| Evidence | Generation metadata API includes model/provider, native token counts, latency, costs and upstream ID | Record native responses and own timings; inspect returned metadata in the adapter pilot |
| Starting effort | One normalized interface can cover the shortlist, with capability differences retained | Existing access; different protocols across the shortlist |
| Qualification | Test an explicit model + endpoint + settings combination | Test the actual Zen route as a whole configuration |

OpenRouter currently advertises 500+ models and 80+ providers on paid plans. Standard is pay as you go with a 5.5% platform fee; no Business subscription is needed for ordinary preferred-provider selection. Enterprise monthly invoicing is a different feature from receiving a PDF invoice for purchased API credits. [OpenRouter plans](https://openrouter.ai/pricing)

The public [OpenRouter catalog](https://openrouter.ai/api/v1/models) includes `openai/gpt-6-luna`, `google/gemini-3.8-flash`, and `deepseek/deepseek-v4.1-flash`. Observed catalog input/output rates per million are $0.10/$0.50, $0.75/$3.75, and $0.112/$0.336 respectively. These are catalog rates, not a quote for every endpoint: capture the selected endpoint's price before each run. Its capability metadata can also differ from the upstream maximum, so configure the actual serving endpoint.

Zen says it selects model/provider combinations that work well for coding agents. That is not evidence of target-selection accuracy on this dataset. [Zen selection approach](https://opencode.ai/docs/zen/#background)

### Keep evaluation routing explicit

For OpenRouter, use one model ID and one exact provider endpoint slug with `only`, `order`, `allow_fallbacks: false`, and `require_parameters: true`. A base provider slug can match several regions/variants, so use the full endpoint slug where available. Do not supply a fallback model list, an automatic router, or a mutable `latest` alias for qualification. Avoid dynamically sorting providers by price/latency during a comparison. [Provider controls](https://openrouter.ai/docs/guides/routing/provider-selection), [model fallback behavior](https://openrouter.ai/docs/guides/routing/model-fallbacks)

Set `X-OpenRouter-Cache: false` for fresh model evaluation. This disables gateway response reuse, which otherwise can replay an earlier answer with a new generation ID. Provider prompt caching is separate and should be recorded in latency/cost comparisons. [Response caching](https://openrouter.ai/docs/guides/features/response-caching)

Do not enable the response-healing plugin in baseline model-contract tests: it repairs malformed JSON and would obscure the model's original format failure rate. If later enabled for the product, qualify it as part of that resolver configuration. [Response healing](https://openrouter.ai/docs/guides/features/plugins/response-healing)

Store each returned generation ID and fetch metadata for provider/model identity, native prompt/completion/reasoning counts, finish reason, timing and total cost. Retain the experiment's own wall-clock measurement as the end-to-end measure. [Generation metadata API](https://openrouter.ai/docs/api/api-reference/generations/get-generation)

Pinning a route improves repeatability; it cannot freeze an upstream provider's weights, infrastructure or load. Neither service establishes bit-for-bit reproducibility here. Continue the frozen-case nightly checks and qualify each model/provider/settings change. Compare a Zen deployment with its own qualified baseline; an OpenRouter score does not automatically qualify the same model name through Zen.

### Invoices and business details

**OpenRouter: yes, downloadable invoices are documented.** Enable **Send me Invoices** when purchasing credits. Set the legal name/address through **Manage Billing** before paying. **Credits → Payment History** opens Stripe, where invoice history and PDFs are available. Its support article says finalized invoice details cannot be retrospectively changed/reissued. [Invoice instructions](https://openrouter.zendesk.com/hc/en-us/articles/41976886293403-Payment-Issues-Common-Fixes)

OpenRouter also documents entering VAT/GST/other supported tax IDs from Add Credits → Edit Tax ID; these apply to future invoices. The guide directs correction requests to support, which is less definitive than the no-reissue support article: do not rely on later correction. Support for the user's particular business tax identifier and the actual invoice contents remain unverified. [Tax ID instructions](https://openrouter.ai/docs/cookbook/administration/tax-id)

**Zen: invoice creation, tax-ID collection and receipts are supported by its public implementation.** Credit checkout enables Stripe invoice creation, requires a billing address and enables tax-ID collection. Reloads create/finalize/pay invoices with credit and processing-fee lines. The code also creates customer billing-portal sessions. This is implementation evidence, not a check of the user's live account or a guarantee of a particular jurisdiction's accounting treatment. [Official billing source](https://github.com/anomalyco/opencode/blob/dev/packages/console/core/src/billing.ts)

The console source has a payment receipt action and a Manage Billing button opening Stripe. A payment receipt and a tax invoice are different documents; the current account's exact invoice download path and business fields should be checked before funding it. [Payment history source](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/workspace/%5Bid%5D/billing/payment-section.tsx), [billing portal source](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/workspace/%5Bid%5D/billing/billing-section.tsx)

This comparison concerns API credit purchases. It does not establish that a coding-agent subscription funds these API experiments. No account, purchase, subscription, automatic reload or billing setting was changed.
