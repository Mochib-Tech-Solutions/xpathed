# Labelled prompt comparison

2026-10-01. **Keep the existing baseline.** The experimental `intent-cardinality` prompt passed its development screen but failed the separately frozen confirmation rule: exact responses fell from 24/30 to 23/30, and correct provider responses within two seconds fell from 22/30 to 21/30. This is a negative experiment result, not evidence of a statistically established regression. No production default changed and no further paid tuning followed confirmation.

## Method and hypothesis

The [completed model comparison](labelled-model-comparison-report.md) selected DeepSeek V4.1 Flash/Wafer for tuning by correct source-target responses within two seconds; Gemini led overall accuracy. The serving configuration remained standard Wafer, reasoning disabled, 4,096 output tokens, strict schema validation, disabled fallback and response reuse.

Manual review found four commands whose singular description was expanded into alternative or fragmented targets. Five raw multi-entry responses existed, but multiple entries alone do not prove an error. One audited case was in the frozen development subset. `intent-cardinality` appends only a clarification that several words or alternative matches do not themselves request multiple targets; explicit plural requests and genuine ambiguity remain supported. Prompt version changes from `7` to `7-intent-cardinality-1`; original instructions, candidates, labels, schema and action/workflow rules do not change.

The earlier `declarative-inspect` hypothesis lacked support in inspected failures and received no paid calls. The historically weaker concise rewrite was also skipped; no prompt sweep occurred.

[Issue #34](https://github.com/Mochib-Tech-Solutions/xpathed/issues/34) defines the staged experiment. Development reused 40 original baseline attempts, one per family, selected before variant outcomes by seeded case-ID hashes. The variant ran once per case. The frozen gate required exact correctness and correct-within-2,000-ms provider counts both to be no worse, with at least one strictly higher.

Confirmation used 30 original test cases, three each in ten families disjoint from development, frozen before prompt inference. The same rule was frozen before confirmation. Each configuration ran once per case, in fixed 15-case blocks ordered baseline A, variant A, variant B, baseline B (**ABBA**). No retries, outcome-based exclusions or confirmation-driven edits occurred. Original payloads were privacy-reviewed and request hashes frozen before inference. Conservative maximum forecasts were $0.23735622 for development and $0.32661708 for confirmation, within the existing shared $5 ledger.

## Paired results

Exact means the complete original labelled singleton target set with valid output. Returning an expected node among unwanted extra targets does not pass. Percentiles below include failures, not just successful responses. Provider timing excludes offline process startup and browser/UI work.

| Sample / configuration | Exact responses | Correct provider <1 s | Correct provider ≤2 s | Provider p50 / p95, ms | Offline p50 / p95, ms |
| ---------------------- | --------------: | --------------------: | --------------------: | ---------------------: | --------------------: |
| Development baseline   |           28/40 |                 13/40 |                 25/40 |            1054 / 2273 |           1353 / 2578 |
| Development variant    |           29/40 |                 17/40 |                 28/40 |             949 / 1784 |           1246 / 2075 |
| Confirmation baseline  |           24/30 |                 16/30 |                 22/30 |             735 / 2510 |           1033 / 2813 |
| Confirmation variant   |           23/30 |                 15/30 |                 21/30 |             698 / 6648 |            990 / 6955 |

Development produced four newly correct and three newly incorrect cases. Both gate counts improved, permitting confirmation.

Confirmation produced two newly correct cases and three newly incorrect cases. Exact correctness improved in two families, declined in three and stayed unchanged in five. All three cases passed in six baseline families versus three variant families. Neither exact accuracy nor the correct-within-two-seconds count satisfied the confirmation rule. The slightly lower variant median does not override its failed correctness/deadline gate or higher observed tail latency.

Confirmation retained one baseline malformed-output error versus two incomplete-output and one malformed-output variant errors. These are model-output contract failures, not automatically provider outages. All failures and original labels remain unchanged.

## Tokens and cost

| Sample / configuration       | Input tokens | Output tokens | Cached input tokens | Reported USD |
| ---------------------------- | -----------: | ------------: | ------------------: | -----------: |
| Development baseline, reused |      317,615 |         2,084 |              17,408 |  $0.01669595 |
| Development variant          |      319,495 |         1,984 |              20,480 |  $0.01665315 |
| Confirmation baseline        |      184,524 |         1,497 |              14,848 |  $0.00975320 |
| Confirmation variant         |      185,934 |         1,376 |              15,360 |  $0.00973830 |

Reported reasoning tokens were zero throughout. The appended prompt added 47 input tokens per request in these measurements. Output tokens declined in aggregate, but provider prompt-cache warmth differed and was uncontrolled; tiny cost differences do not establish a repeatable saving.

The reused development baseline was already billed in stage one. **New stage-two spend was $0.03614465** for 100 calls: 40 development variant calls plus 60 confirmation calls. All 100 have distinct fresh generation identities and known charges; no new timeout reservation required review.

At completion, the shared experiment ledger held **$2.0134063058 provider-reported charges** plus **$0.014334 in two conservatively reviewed reservations from stage-one timeouts**. Total consumed was **$2.0277403058**, leaving **$2.9722596942** under the unchanged $5 ceiling. The two historical costs remain unknown; reviewed reservations are not reported as actual provider charges.

## Evidence and limits

The new development and all confirmation runs recorded source revision `fecb63c`. Independently recomputed grades exactly reproduce their saved summaries. Every actual request matches its prepared request hash; paired original inputs and schemas match, target labels remain unchanged, and all confirmation families are disjoint from development. All confirmation runs share the same source fingerprints. Development preparation and execution have different rebuilt Resolver/Common DLL hashes, retained in the audit; source-file hashes and actual request bytes match.

Private paired audits are `.artifacts/datasets/phrasenode-dev-expanded-preparation/stage2-development-paired-audit.json` and `stage2-confirmation-paired-audit.json`. Frozen hypothesis, selection and baseline references are alongside them; `.artifacts/datasets/stage2-confirmation-execution-plan.json` records ABBA order and the decision rule. Original summaries and the shared ledger remain preserved; page/provider payloads stay private under existing retention rules.

At each recorded source revision, replay without new inference:

```sh
rtk pnpm evaluate:dataset --replay .artifacts/datasets/stage2-cardinality-dev-prepared/run
rtk pnpm evaluate:dataset --replay .artifacts/datasets/stage2-confirmation-baseline-a
```

Replay the other blocks by substituting `variant-a`, `variant-b` and `baseline-b`. Focused Resolver/runner tests, source review and local gates passed; hosted CI is checked separately before merge.

These are small, reviewed convenience samples, with one call per configuration and correlated cases within page families. ABBA reduces a simple order imbalance but does not control provider load, caching or inference randomness. The development baseline was collected earlier. The observed differences support the frozen keep-baseline decision, not a population-level or causal claim.

PhraseNode supplies target labels, not independent action, readiness or plural-completeness labels. Offline/provider timings cannot establish the live application's sub-second response goal or two-second maximum. Public-dataset training exposure and residual source-label ambiguity are unknown. Confirmation families are now exposed and must not serve as unseen evidence in later tuning. Neither configuration is promoted or described as production-qualified.
