# Resolver comparisons and provider drift

This is historical design research. The implemented, pinned v4 comparison and current serving/budget decisions are documented in the [Stagehand comparison report](stagehand-comparison-report.md) and [evaluation contract](../evaluation.md). Older v3 or gateway proposals below are not runtime configuration.

Research checked 2026-09-29. Recommendations below are proposed evaluation design, not implemented behavior or measured results.

The accepted gateway is OpenRouter only. Zen references below preserve earlier research and do not call for a Zen adapter or gateway comparison. See specification issue #1 and the OpenRouter section of [model selection research](fast-model-selection.md).

## Stagehand as a baseline

This section describes the v3 APIs linked below. The current repository changelog lists v4.0.1; choose and pin the benchmark release before implementing its adapter, then verify its matching API contracts. [Stagehand changelog](https://github.com/browserbase/stagehand/blob/main/CHANGELOG.md)

Stagehand `observe(instruction, { page })` returns actions ordered by relevance. Each includes a selector documented as XPath, description, and optional interaction method/arguments. Its observation options include a model override and explicit page selection. Use the first returned action as the selected target; an empty list represents no candidate. Never pick the best matching answer from the list using the evaluation labels. [Observe reference](https://docs.stagehand.dev/v3/references/observe)

Stagehand can share its browser with Playwright over CDP and accept the attached Playwright page. This documents a JavaScript integration; a .NET implementation needs a small separately versioned Node benchmark adapter. A .NET browser object cannot be passed directly into JavaScript. [Playwright integration](https://docs.stagehand.dev/v3/integrations/playwright)

Use the same fixture revision, prepared state, viewport, scroll position, locale, browser build, and instruction for both strategies. Reset state between trials. Stagehand processes the page itself, so equal browser state does not imply equal internal DOM representation or model prompt. Record those differences when observable.

Two comparisons answer different questions:

| Comparison           | Hold fixed                                                                          | What it answers                                                        |
| -------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Controlled           | Provider endpoint/model, supported inference parameters, task limits, browser state | How the resolution strategies differ under comparable model access     |
| Native configuration | Cases, grading, browser state; disclose each strategy's selected model/settings     | Which complete configuration gives the best quality, latency, and cost |

Stagehand supports provider/model configuration, custom endpoints, and an AI SDK client integration. Validate the chosen Zen protocol/model combination before declaring it supported. If an inference setting cannot be matched, disclose it rather than claiming a controlled comparison. [Model configuration](https://docs.stagehand.dev/v3/configuration/models)

Grade the returned selector independently against the expected target in its document/frame. Apply the same hidden-element exclusion and viewport preference to both strategies' outputs. Record contract violations and unsupported cases; do not silently remove them from the overall denominator. Report common supported coverage separately. Stagehand advertises iframe and shadow DOM support, but our plain XPath contract still requires explicit frame context and excludes shadow-root targets initially. Any conversion from a compound selector must be explicit and verified. [Observe reference](https://docs.stagehand.dev/v3/references/observe)

## Separate resolution from execution and caching

Do not invoke `act()` to grade target selection. A correct action outcome after a repair could hide an incorrect original selector. Validate XPath syntax, unique match, selected-node identity, and target state with the common deterministic grader. Optionally run actions afterward on controlled fixtures as a separate outcome metric.

Stagehand documents `selfHeal` as enabled by default and describes action descriptions as healing context. If an execution comparison uses Stagehand, explicitly disable healing for the unchanged-selector score; measure healed execution separately. [Constructor](https://docs.stagehand.dev/v3/references/stagehand), [Act reference](https://docs.stagehand.dev/v3/references/act)

For fresh inference measurements, prefer `LOCAL`, no configured persisted action cache, and a fresh adapter process per isolated trial. Document actual behavior of the pinned library. Browserbase server caching can be disabled with the documented `serverCache: false`; that switch does nothing in local mode. Local action caching is configured with `cacheDir`. Do not invent a generic `disableCache` flag or assume local/server/provider caches are equivalent. [Caching](https://docs.stagehand.dev/v3/best-practices/caching), [Observe options](https://docs.stagehand.dev/v3/references/observe)

Keep cached replay tests separate from fresh-model tests. Record inference counts, elapsed time, and token/cache usage when exposed. Provider prompt caching may still occur; it is different from replaying a saved target without new inference.

## What Zen exposes

Zen documents a model catalog at `/zen/v1/models`, model-specific endpoints/protocols, and a deprecation list. Its documentation describes curating model/provider combinations, but the inspected page does not promise immutable serving revisions, a user-controlled upstream route, or universal response fingerprints. A fixed model ID therefore does not establish frozen remote behavior. [Zen](https://opencode.ai/docs/zen/)

Persist the requested model ID, endpoint/protocol, parameter values, and a sanitized catalog snapshot/hash. Capture the returned model name, provider/revision/fingerprint, request ID, token usage, and cache metadata only when actually exposed. Missing fields remain unknown. Catalog availability is a compatibility check, not evidence of unchanged quality.

## Proposed drift checks

1. Freeze the approved code/artifact, dependencies, browser/container revision, DOM processing, prompt/schema, model parameters, evaluation data, graders, and expected labels. Hash the complete manifest.
2. Keep recorded-response tests for deterministic parsing, validation, and error behavior. They do not detect provider drift.
3. Schedule a small live sentinel suite on the frozen approved artifact. Include duplicate targets, viewport preference, scoped labels, frames, disabled states, hidden exclusions, absent targets, and malformed/adversarial page text. Use synthetic data and fresh inference; check the artifact hashes first.
4. Repeat each case a predeclared number of times. Preserve every attempt; retrying until green is not a valid measurement. Set the repetition count and thresholds from measured baseline variation and the available budget.
5. Compare with the approved configuration's historical distribution: intended-target accuracy, wrong-target rate, false `not_found`, schema/contract failures, category regressions, and p50/p95 latency. Include per-case results and uncertainty; tiny samples cannot establish small improvements.
6. During promotion, run incumbent and candidate on the same cases near the same time, alternating order with equal concurrency and retry limits. This paired comparison detects release regressions; the historical sentinel detects changes affecting an unchanged incumbent. They serve different purposes.
7. Separate provider errors, authorization/rate limits, and harness failures from semantic failures. Report completion coverage as well as quality; missing trials never count as passes. Record first-attempt and eventual completion separately if transport retries are enabled.
8. On a hard contract/critical-case failure or an agreed material quality drop, block promotion and preserve the failing evidence. Run one bounded confirmation batch for diagnosis; keep the initial failure in the report. Notify the maintainer through the configured CI check/artifact mechanism.
9. Do not auto-edit expected labels, soften gates, or silently replace the active model. Rollback can select a previously qualified configuration only if its provider remains available and currently passes the relevant checks. Rolling back our code cannot restore a remote provider's previous weights.

A nightly sentinel is a starting proposal; a weekly broader live suite can supplement it. Keep scheduled sentinels in the visible regression set. Reserve held-out page families for promotion qualification, refresh them deliberately after exposure, and never tune prompts against their labels. Confirm cadence, call budget, repetitions, and gates before implementing paid CI runs.

No finite evaluation guarantees perfect operation on every website. The release claim should identify the tested cases, supported scope, uncertainty, and approved configuration.
