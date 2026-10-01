# Evaluation timeout recovery

2026-10-01. Investigation for [issue #50](https://github.com/Mochib-Tech-Solutions/xpathed/issues/50), following the interrupted original-labelled expansion. Research and deterministic checks made no inference calls.

## Provider evidence

OpenRouter documents that cancelling a non-streaming request does not stop model processing or billing. It exposes `X-Generation-Id` on responses, which can identify a request before its body finishes. A timeout is therefore neither evidence of zero cost nor proof that a response can be recovered. Streaming changes the wire contract and has provider-dependent cancellation support; introducing it would require a separate measured configuration. [Streaming and cancellation](https://openrouter.ai/docs/api_reference/streaming).

`GET /api/v1/generation?id=…` requires the generation ID and returns request metadata, including `total_cost`, model and provider. A bounded metadata lookup can reconcile a known request after its response body fails. It cannot run without an ID, and a missing record must remain unknown. [Generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-generation).

The activity API aggregates by endpoint and completed UTC day and requires a management key. It is not an individual-request recovery API. Neither an unchanged key total nor a daily aggregate identifies the cost of a specific interrupted request. [Activity API](https://openrouter.ai/docs/api/api-reference/analytics/get-user-activity).

HTTP success alone is insufficient: a non-streaming response can return status 200 with an error body. Preserve HTTP status and typed error metadata separately. The optional upstream-body debugging feature is streaming-only and can expose request content; it is unnecessary for connectivity checks. [Error handling](https://openrouter.ai/docs/api_reference/errors-and-debugging).

OpenRouter's own model-discovery guide defines endpoint status `0` as operational and nonzero as degraded. No more specific first-party definition of `-2` was established here. Our operational-only preflight rejects it, but “degraded” is better wording than asserting the route is administratively disabled. Endpoint metadata includes recent latency, throughput and uptime; these are diagnostic snapshots, not a guarantee for the next completion. [Official discovery guide](https://github.com/OpenRouterTeam/skills/blob/main/skills/openrouter-models/SKILL.md), [endpoint API](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model).

## What the local evidence establishes

At the inspected pre-repair revision, [OpenRouterGateway](../../src/Resolver/Services/OpenRouterGateway.cs) uses a default 30-second HTTP timeout. The offline runner invokes the [budget proxy](../../evaluation/comparison-budget.mjs), which reserves remotely before forwarding, allows the upstream request 45 seconds, then reconciles remotely before replying on its ordinary path. Both accounting writes are inside the resolver's wait. The [partial measurement](expanded-labelled-evaluation-report.md) records approximately 1.465-second reservation and 1.502-second reconciliation medians. This overhead can cause a resolver timeout near its boundary; subtracting those medians does not establish application latency.

The two retained missing-charge records tell a narrower story: their proxy attempts lasted 46.333 and 46.662 seconds, with reservation times of 1.328 and 1.653 seconds, no reconciliation, no HTTP status and no retained headers. They reached the upstream 45-second timeout after reservation. Local accounting explains the additional elapsed time, but does not establish the cause of the upstream wait. These records do not prove whether the fault was local connectivity, OpenRouter, or Wafer. No generation ID can be reconstructed from them.

The proxy previously omitted `X-Generation-Id` from its retained headers. The narrow repair retains available headers before reading the body. If body retrieval fails and a generation header exists, it makes one bounded metadata lookup. Only a matching generation, model and provider with a finite nonnegative charge within the reservation can settle that charge. The original error, absent completion and failed attempt remain unchanged; missing or unverifiable accounting retains the full reservation. Recovery does not retry inference or silently continue the failed wave.

## Safe checks and continuation

1. Measure DNS/TLS/HTTP connectivity to GitHub and OpenRouter metadata endpoints without submitting a completion. Report timings and response status separately from inference health. Check the selected route's operational status and current prices immediately before a paid wave.
2. Inspect saved request IDs, HTTP headers and timeout stages. Query generation metadata only for an actually observed ID. Do not invent identity or infer a zero charge from account totals.
3. Verify accounting ordering with deterministic delayed-response and delayed-ledger tests. If changing timeout or accounting placement, freeze a new protocol receipt and report the timing cohorts separately; preserve the original 53 attempts.
4. Keep the pinned standard route, original prompt, reviewed request hashes, one attempt per case and cumulative $10 ceiling. Resume only never-attempted cases after the unresolved charge is explicitly reconciled or reviewed under the existing policy. General retry guidance does not authorize retrying benchmark failures or changing providers inside this cohort.

This evidence supports correcting harness timing and metadata retention. It does not establish a faster model, a completed 860-case baseline, or recovery of the two historical unknown charges.

## Standard provider selection

The maintainer explicitly approved a separate alternate-provider baseline after the network recheck, and requested the same provider review for the other models. Free metadata calls at 16:36 UTC returned HTTP 200 in approximately 146 ms for GitHub, 160 ms for OpenRouter endpoints and 191 ms for the evaluation-key endpoint. These establish connectivity at that time, not inference health. Wafer remained non-operational under our status-0-only policy at 16:37 and 16:39 UTC.

The 16:39 UTC endpoint snapshots support these choices:

| Model               | Selected standard route               | Advertised one-day uptime | Input / output USD per million tokens |
| ------------------- | ------------------------------------- | ------------------------: | ------------------------------------: |
| DeepSeek V4.1 Flash | DeepInfra FP8 (`deepinfra/fp8`)       |                  99.9626% |                         $0.14 / $0.42 |
| GPT 6 Luna          | OpenAI (`openai`)                     |                  99.8933% |                         $0.10 / $0.50 |
| Gemini 3.8 Flash    | Google AI Studio (`google-ai-studio`) |                  99.8631% |                         $0.75 / $3.75 |
| Qwen3.8 Flash       | Alibaba (`alibaba`)                   |                  99.8481% |                         $0.15 / $0.47 |

All four advertise the current required `response_format`, `structured_outputs`, `reasoning` and `max_tokens` controls. DeepInfra had nearly Together's reported daily availability at substantially lower standard rates; cheaper Morph and OpenInference routes had lower reported daily uptime. Azure advertised higher Luna uptime but `max_completion_tokens` instead of this harness's required `max_tokens`, so it was not a compatible drop-in. Gemini's standard Vertex route was non-operational with materially lower recent uptime, and Qwen listed only Alibaba. These are compatible choices based on one provider-reported snapshot, not proof of globally best reliability. Every endpoint returned null recent latency and throughput, so no speed ranking is inferred. Sources: [DeepSeek](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints), [Luna](https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints), [Gemini](https://openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints), [Qwen](https://openrouter.ai/api/v1/models/qwen/qwen3.8-flash/endpoints).

The explicit offline profile `deepseek-deepinfra` preserves the original model, prompt version 7, source instructions, candidate payloads, schema, reasoning and output limit. The 860 reviewed requests differ only in their pinned provider fields. Its pilot and remainder have separate frozen manifests from the 53 Wafer attempts; neither a provider change nor better uptime can relabel those failures. Other comparison routes stay unchanged. The shared campaign retains every historical charge and the entire two timeout reservations, with unknown reported costs still null. A later provider baseline must retain these boundaries and measure actual speed, correctness and cost before any adoption decision.
