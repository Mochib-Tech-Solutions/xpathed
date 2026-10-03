# Completed labelled baseline and standard provider comparison

2026-10-01. Follow-up to [issue #50](https://github.com/Mochib-Tech-Solutions/xpathed/issues/50). **DeepSeek V4.1 Flash through standard DeepInfra FP8 completed all 860 reviewed requests: 547 correct (63.60%), with $1.618648388 reported cost.** Measurement is complete; this exposed source-data baseline does not qualify a release or establish browser response latency.

## Fixed source baseline

The [original selection and review](expanded-labelled-evaluation-report.md) remain unchanged: 1,000 candidate records, 130 review exclusions, seven duplicate requests and three matches to earlier attempted inputs. The final 860 cases span 180 page families and 581 distinct source targets. Every instruction, serialized candidate set and original singleton target label was retained. No cases were replaced after observing outcomes.

After the interrupted Wafer run, the maintainer approved a separate provider baseline. At paid source revision `32bb757decfe76db36c1f3d71d52c3c7698dec42`, the explicit `deepseek-deepinfra` profile changed only the pinned provider fields of the prepared requests. Model, baseline prompt, reasoning setting, output cap and schema stayed fixed. The seven-case pilot completed with verified transport/accounting and six correct selections; expansion retained its failure. Nine more waves completed the remaining 853 cases, one attempt each. Ten wave configuration identities reflect batch metadata, not ten prompt variants.

All 860 reviewed input hashes, frozen/forwarded request hashes, original labels and unique generation identities were verified. Every wave was replayed; a second direct singleton comparison independently confirmed 547 correct. The [safe execution receipt](deepinfra-labelled-baseline-execution.json) contains aggregate results and evidence hashes. Raw source payloads, instructions and provider responses remain private under `.artifacts/datasets/expanded-deepinfra-dev-860/`.

| Result                                           | Measurement                                       |
| ------------------------------------------------ | ------------------------------------------------: |
| Attempted / planned                              | 860 / 860                                         |
| Strict whole-response target correctness         | 547 / 860 (63.60%)                                |
| Failed attempts                                  | 313                                               |
| Transport, provider-identity or billing failures | 0                                                 |
| Output-contract errors                           | 49: 33 malformed responses, 16 incomplete results |
| Reported provider cost                           | $1.618648388                                      |
| Input / output tokens                            | 11,955,326 / 45,951                               |
| Saved-page elapsed median / p95                  | 5,254 / 6,750 ms                                  |

The mutually exclusive outcomes were 693 found (547 correct, 146 wrong), 87 not found, 31 unsupported and 49 errors. A valid source target exists in every approved case, so absence and unsupported outcomes still fail source target selection. Merely including the gold node among extra guesses does not pass: gold appeared somewhere in 562 responses, while only 547 met strict correctness. All failures remain in the denominator.

| Target group                  | Correct / attempted |
| ----------------------------- | ------------------: |
| Links                         |           239 / 398 |
| Buttons                       |            96 / 143 |
| Inputs                        |           188 / 287 |
| Selects                       |             24 / 32 |
| Named in serialized context   |           495 / 657 |
| Unnamed in serialized context |            52 / 203 |

The 203 unnamed cases expose a substantial representation/selection gap; this association does not establish a single cause. Overlapping lexical subsets scored 26/43 spatial, 31/49 ordinal, 1/4 color-word, 10/18 plural-word and 121/145 input-verb. These are sampling cues, not independently labelled visual, action or plural-set correctness. In particular, the four color-word cases cannot establish color capability.

## Timing and comparison boundaries

Saved-page elapsed includes preparation and process startup. Both the .NET diagnostic named `provider` and proxy elapsed include inline remote GitHub budget accounting. Reservation and reconciliation medians were 1,608 and 1,603 ms. Do not subtract aggregate medians to claim inference speed, browser latency or the two-second application deadline. The separate [current-view baseline](viewport-baseline-report.md) remains the measured source for viewport context reduction and HTTP response time.

The original 53 Wafer attempts were preserved and independently regraded. On those same 53 cases:

| Measure                   | Wafer                        | DeepInfra FP8 |
| ------------------------- | ---------------------------: | ------------: |
| Strict correctness        | 36 / 53                      | 39 / 53       |
| Saved-page median         | 6,834 ms                     | 4,938 ms      |
| Saved-page p95            | 29,491 ms                    | 6,538 ms      |
| Known reported cost       | $0.04142443                  | $0.113151808  |
| Unknown cost reservations | $0.01538460 across two calls | $0            |

DeepInfra's observed median was 27.74% lower on this shared cohort and it was faster on 36/53 cases. Both routes were correct on 34 cases; Wafer alone on two, DeepInfra alone on five, neither on 12. Among the 34 both-correct cases, medians were 6,834 versus 5,078 ms and costs were $0.03006276 versus $0.079476376. DeepInfra was more expensive on these known-charge comparisons.

This is a selected interrupted prefix measured at different times, with separately built harness revisions and different provider infrastructure/precision. It is descriptive evidence, not a causal provider ranking or proof of long-term stability. The full 860-case composition also differs from the earlier 191-case sample; comparing their raw scores as an improvement or regression would be invalid. The historical Wafer run remains 53/860, with 807 unattempted under that configuration; the authorized separate DeepInfra run completes the expanded measurement.

## Provider choices

The [dated provider investigation](evaluation-timeout-recovery-2026-10-01.md#standard-provider-selection) checked operational status, required controls, standard prices and advertised one-day uptime. Recent latency/throughput values were unavailable, so metadata alone did not establish a fastest route. No priority tier or automatic fallback was used.

| Model               | Route recommended for the next evaluation | Evidence and limit                                                                                                                  |
| ------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| DeepSeek V4.1 Flash | DeepInfra FP8 (`deepinfra/fp8`)           | 860 completed calls without transport/billing failure; 99.9626% advertised daily uptime at the snapshot. More expensive than Wafer. |
| GPT 6 Luna          | OpenAI (`openai`), provisional            | Equal seven-case accuracy and lower median than Azure in the frozen paired pilot.                                                   |
| Gemini 3.8 Flash    | Google AI Studio (`google-ai-studio`)     | Operational standard route, 99.8631% advertised daily uptime; standard Vertex degraded at the snapshot. Not rerun here.             |
| Qwen3.8 Flash       | Alibaba (`alibaba`)                       | Only listed endpoint, operational, 99.8481% advertised daily uptime. Not rerun here.                                                |

Sources: official OpenRouter endpoint snapshots for [DeepSeek](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints), [Luna](https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints), [Gemini](https://openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints) and [Qwen](https://openrouter.ai/api/v1/models/qwen/qwen3.8-flash/endpoints). These choices are bounded by observed evidence; none proves a globally best provider or changes runtime configuration.

### Luna compatibility and paired pilot

Azure's advertised `max_completion_tokens` initially failed this harness's literal `max_tokens` requirement. That was a harness limitation, not evidence of model incompatibility. [PR #55](https://github.com/Mochib-Tech-Solutions/xpathed/pull/55) added an exact saved-page-only Azure profile using its supported cap, reasoning `none` and explicit prompt-cache controls. Conflicting output caps are rejected before payment.

At source revision `6a7d63f5f10f6c8f37280bdef93ad3ea532493ad`, the same seven reviewed cases ran once per route with unchanged instructions, context, prompt and labels. A decision policy recorded before inference required Azure to have seven valid standard-route billing records, accuracy at least equal to OpenAI and a lower saved-page median. OpenAI ran first, then Azure; time, order and cache effects remain confounded.

| Pilot result       | OpenAI     | Azure      |
| ------------------ | ---------: | ---------: |
| Strict correctness | 6 / 7      | 6 / 7      |
| Saved-page median  | 5,464 ms   | 5,778 ms   |
| Saved-page p95     | 7,285 ms   | 6,688 ms   |
| Reported cost      | $0.0242059 | $0.0242104 |

Both failed the same case. Azure's lower observed tail and higher advertised daily uptime do not override the precommitted median rule: **retain OpenAI provisionally for the next evaluation**. Azure remains an explicit evaluation alternative. Seven sequential cases cannot establish long-term stability, a reliable p95 or general model superiority. The pilot cost $0.0484163; no further paid comparison was needed to apply the frozen rule. The [audited pilot receipt](luna-provider-pilot-execution.json) preserves per-case results, timing, charges, the policy hash and final campaign reconciliation. All calls used standard service tier, zero reported cache/reasoning tokens and base rates of $0.10/$0.50 per million input/output tokens. Conservative forecasts used higher maximum advertised tier/cache-write rates, not actual premium serving.

## Budget and next boundary

These two experiments added **$1.667064688 in known charges**. Cumulative campaign consumption is **$3.7589995438 of $10**, leaving **$6.2410004562**. Consumption includes four historical unknown charges conservatively reviewed at their full $0.02971860 reserved maximum; their reported costs remain null. There are no pending unreviewed charges. Neither the ledger nor the campaign ceiling was reset. The dedicated evaluation key reports $1.715874638 total usage; it does not include older campaign charges made before that key was created. The authoritative ledger contains 2,456 entries, and the local authority cache is synchronized.

The expanded source measurement is complete. It does not qualify any model, establish current-viewport/action/readiness/plural correctness or authorize a production provider switch. Context efficiency remains the separate browser baseline. The classifier-assisted context experiment remains [issue #48](https://github.com/Mochib-Tech-Solutions/xpathed/issues/48), with a fixed LLM for its first comparison; release qualification remains [issue #11](https://github.com/Mochib-Tech-Solutions/xpathed/issues/11).
