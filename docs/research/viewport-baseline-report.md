# Current-view baseline

2026-10-01. The current-view pipeline uses substantially fewer tokens on this controlled sample, particularly on a long page. Typical response time changed modestly. **Command correctness is not perfect: 14/16 current-view requests passed, versus 15/16 legacy requests.** Neither arm qualifies a release. This is the measured LLM-only control for [#48](https://github.com/Mochib-Tech-Solutions/xpathed/issues/48), not model promotion or a production latency guarantee.

## Frozen comparison

The corrected run is `4ba0650e-31d6-4835-92ef-1541dc8309e6`, source `fc858ea7a232b4b0180b387d3274f691b4ff9f10`. It contains 32 independently reviewed, authored browser cases from 14 families, all regression: 12 unchanged-target pairs, one color-capability pair and three scope-change pairs. Cases exercise labels, Unicode/quotes, structural scope, disabled/readonly/checked controls, fill/click/check actions, plural targets, absence, injected page instructions, spatial/color references, a long list, viewport boundaries and clipped frames. These are controlled browser labels, not invented labels for imported datasets, and are not an exhaustive command inventory.

Both arms use standard `deepseek/deepseek-v4.1-flash` through Wafer, reasoning disabled, a 4,096-token output ceiling, no provider fallback, no response reuse and one attempt per case. Seed 47 keeps unchanged-target pairs adjacent and alternates their first position. Every attempt starts a fresh browser session at 1279 × 799. There are no discarded warmups or retries. Provider prompt-cache warmth is uncontrolled and recorded.

The legacy arm uses page-wide capture and selection. The current-view arm adds viewport filtering, a revised selection prompt, compact state serialization, CSS evidence and the original two-second processing deadline. Both arms use the same state/readiness and XPath policies. Both run the same source revision; this is a comparison of preserved legacy semantics against the new pipeline, **not a rerun of the historical source binary**, nor an experiment isolating serialization from every other change. Legacy pricing uses the proxy's frozen metadata snapshot; current-view resolution omits optional price lookup.

[Evidence identities](viewport-baseline-evidence.json) retain source/tree, Chromium, manifest, summary, prompt, schema and configuration hashes. [Per-attempt measurements](viewport-baseline-results.csv) retain all 64 attempts from the original and corrected protocols, including failed attempts and source trial hashes. Raw evidence remains in the private run directories named in the identities file, under the documented retention policy. The case specification is `evaluation/viewport-baseline-cases.json` at the recorded revision.

## Unchanged-target pairs

These rows include all 12 requests per arm, including the failed current-view plural result. Byte totals concern serialized user context; actual input tokens also include system prompt and schema. Timing p50/p95 uses the saved report's nearest-rank convention; with 12 observations, p95 is the maximum.

| Measure                          |           Legacy |     Current view |                   Observed change |
| -------------------------------- | ---------------: | ---------------: | --------------------------------: |
| Correct complete commands        |            12/12 |            11/12 |           −8.33 percentage points |
| Correct below one second         |            10/12 |            11/12 |           +8.33 percentage points |
| Correct within two seconds       |            11/12 |            11/12 |                         unchanged |
| User-context bytes, total        |           85,820 |           24,065 |                           −71.96% |
| Actual input tokens, total       |           35,635 |           15,966 |                           −55.20% |
| Actual output tokens, total      |              608 |              595 |                            −2.14% |
| Capture evidence bytes, total    |          147,038 |           51,272 |                           −65.13% |
| HTTP p50 / p95                   |  826 / 14,538 ms |   800 / 1,000 ms |   all attempts, including failure |
| Capture p50 / p95                | 15.45 / 25.00 ms | 14.05 / 26.75 ms |                small mixed change |
| Model stage p50 / p95            |  790 / 14,489 ms |     761 / 958 ms |       includes provider transport |
| Verification p50 / p95           | 17.93 / 21.64 ms | 18.32 / 22.15 ms |                    small increase |
| Server total p50 / p95           |  824 / 14,535 ms |     798 / 998 ms |                      all attempts |
| Provider-reported USD            |      $0.00202879 |      $0.00101194 |   −50.12%, unequal success counts |
| Estimated USD                    |      $0.00214655 |      unavailable |     optional lookup omitted in v4 |
| Reported USD per correct command |      $0.00016907 |      $0.00009199 | failures remain in cost numerator |

The arithmetic median HTTP duration was **827 → 803 ms**, about **2.91% lower**. Mean/summed timing is dominated by the long-list case: **14,538 → 878 ms**, with **250 → 16 candidates**, **67,665 → 4,819 context bytes** and **22,755 → 2,412 input tokens**. One observation cannot establish that input reduction caused the entire latency difference; serving variability and cache warmth remain confounders.

Small pages gain CSS evidence. Median context size increased **1,251.5 → 1,332.5 bytes (+6.47%)**; excluding the long-list case, total context grew **18,155 → 19,246 bytes (+6.01%)**. The aggregate reduction is not a promise that every page becomes smaller or faster.

Only **11 pairs passed in both arms**. On that explicitly selected subset, summed HTTP duration fell **23,016 → 8,781 ms (61.85%)** and reported cost fell **$0.00193797 → $0.00092352 (52.35%)**. The large-page outlier dominates those timing totals. Removing it leaves ten both-correct pairs with summed durations **8,478 → 7,903 ms (6.78%)**. These descriptive subset results do not replace the all-attempt correctness denominators.

Both arms captured all **12/12** independently labelled paired targets. Model-input target coverage was **10/10** where independently observed; two cases per arm lack that observation and are not silently counted as passes. Returned target sets were complete **11/11**, with no wrong, duplicate or extra targets; state checks passed **6/6** and readiness **11/11** in each arm. The v4 command failure concerns step metadata, not missing targets. No timeout occurred in the corrected run; one legacy response exceeded two seconds because that legacy contract retains its older deadline.

## Scope and color cases

Keep these outside paired efficiency claims because their intended target sets or supported evidence differ.

| Stratum                             | Legacy correctness | Current-view correctness | Observation                                                                  |
| ----------------------------------- | -----------------: | -----------------------: | ---------------------------------------------------------------------------- |
| Ordinary CSS color reference        |                0/1 |                      1/1 | New CSS evidence resolved the labelled target; legacy reported unsupported   |
| Viewport/clipping/plural boundaries |                3/3 |                      2/3 | Frame clipping and visible-only plural set passed; empty current view failed |

The two current-view failures remain unchanged:

- `offscreen-help-v4`: capture correctly excluded the only off-screen element. The model returned `complete:false, actions:[]`; resolution reported `decomposition_incomplete` instead of scoped absence. This is a model-output failure, not a timeout or a reason to search off-screen.
- `single-action-plural-confirmations-v4`: both intended Approve buttons, their unique XPaths and disabled/readiness states were correct, but the model emitted steps 1 and 2. Unordered plural expansion requires shared step 1, so the complete command fails. Consecutive steps remain legitimate for explicitly ordered/named targets; the grader was not relaxed and output was not normalized after seeing this result.

Across all 16 cases per arm, correctness was **15/16 → 14/16**, correct below one second **12/16 → 13/16**, and correct within two seconds **14/16 → 14/16**. HTTP p50/p95 was **828/14,538 → 806/1,127 ms**. Current-view failure rate was **12.5%**, with **0% timeouts**. All 14 expected current-view target identities were captured and returned correctly; that narrower target score does not erase the two full-command failures. All-case capture p50/p95 was **15.78/38.90 → 15.84/40.46 ms**, so this run does not demonstrate faster capture.

## Timing correction and charges

The original run `74b1c13d-d3c3-4bf7-a55a-7a2bba6a46e5` at `8ca392ac4ddf87084776c0c00a9e2081a54d8466` placed two durable GitHub budget writes inside request timing. Those writes alone took at least **2,492 ms** for legacy and **2,708 ms** for current-view calls. Legacy passed 15/16; current view returned **16/16 deadline failures**. There were no both-correct pairs and no successful speedup. Original artifacts and scores remain unchanged, including late provider charges.

The prospective corrected protocol, `resolver-http-pre-reserved-v2`, reserves the entire frozen conservative per-request ceiling durably **before** resolution. The proxy validates the actual request and returns the provider response before remote reconciliation. Accounting and evidence must settle before another attempt or final reporting; unknown/unused reservations and write failures halt the run. No deadline was extended and no overhead was subtracted retrospectively. General hosted release qualification keeps its existing timing contract. All 77 Browser/Resolver/Common source fingerprints match between these two runs; the correction changes evaluation instrumentation and reporting.

| Run / arm                              | Provider-reported USD |
| -------------------------------------- | --------------------: |
| Original instrumentation run, 32 calls |           $0.00382346 |
| Corrected legacy arm, 16 calls         |           $0.00231608 |
| Corrected current-view arm, 16 calls   |           $0.00124598 |
| Corrected run, 32 calls                |           $0.00356206 |
| Both retained runs, 64 calls           |       **$0.00738552** |

Both runs passed deterministic preparation and a conservative **$0.157526688** combined-reservation forecast before their calls. Every call has a unique fresh generation, valid standard-route identity, known charge and durable reconciliation. The dedicated evaluation key was used. Campaign spend is now **$2.0351258258**, leaving **$2.9648741742** under the original **$5** ceiling; the key's separate $15 cap does not increase that allowance. No recurring paid CI was enabled.

In the corrected run, all-case reported cost per correct command was **$0.00015441 → $0.00008900**. The legacy estimate totaled **$0.00246200**; current-view estimates remain unavailable rather than zero. Actual input/output tokens were **39,124/843 → 19,314/753**. Cached input tokens differed (**14,592 → 17,152**), so billed savings cannot be attributed solely to context size. Accounting summaries use settled provider records even when the runtime response timed out; those charges never turn a failed resolution into a successful one.

## Source evidence and next boundary

The separate [original-label model comparison](labelled-model-comparison-report.md) measured 191 original PhraseNode development cases from 40 page families, once per model. DeepSeek obtained **133/191 exact source-target responses** and **120/191 correct provider responses within two seconds**. Those historical saved-page scores do not label action correctness, current viewport membership, readiness, plural completeness or live XPath verification.

The later [prompt comparison](labelled-prompt-comparison-report.md) exposed 30 original test cases from ten families: baseline **24/30 exact, 22/30 within two seconds**, versus variant **23/30, 21/30**. It retained the baseline. The earlier model report's “test split untouched” statement describes that earlier stage only. Current browser cases are explicitly reviewed regression data; the qualification inventory has no fresh held-out cases. No remaining family is declared fresh based only on absence from inference logs; preparation and review exposure also count.

The current-view contract has deterministic Browser/Resolver/Web and CI coverage, and this measurement establishes its observed baseline. The two model failures remain risks for [release qualification #11](https://github.com/Mochib-Tech-Solutions/xpathed/issues/11) and must stay in the fixed control for [context-planning comparison #48](https://github.com/Mochib-Tech-Solutions/xpathed/issues/48). Neither the model default nor a release is approved by this report. Future work must compare against retained evidence, preserve failed attempts and freeze any changed prompt/schema before another measurement.

To reproduce the development protocol, use a fresh output directory, the dedicated local evaluation key and the existing authoritative ledger; never reset or replace the ledger:

```sh
pnpm evaluate:qualify -- --suite evaluation/viewport-baseline-cases.json --mode live --phase pilot --split regression --profile deepseek --repetitions 1 --seed 47 --output .artifacts/evaluation/viewport-baseline-new
```

Replay each run at its recorded source revision with `pnpm evaluate:qualify:replay RUN_DIRECTORY`; replay performs no paid inference. Small one-attempt samples and uncontrolled serving/cache conditions do not certify production percentiles or broad accuracy.
