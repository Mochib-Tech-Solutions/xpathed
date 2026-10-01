# Labelled dataset model comparison

2026-10-01. **Comparison paused after 524 of 764 planned attempts:** a DeepSeek timeout left one provider charge unknown. The shared budget guard stopped further paid work. This partial report preserves the original failures and distinguishes paired results from unequal remaining coverage; no optimization candidate or production default is selected yet.

## Comparison contract

The declared sample is **191 original PhraseNode development cases from 40 page families**, once per model: Qwen3.8 Flash/Alibaba, Gemini 3.8 Flash/Google AI Studio, GPT-6 Luna/OpenAI and DeepSeek V4.1 Flash/Wafer. All receive the same baseline version-7 system prompt, output schema and per-case instruction/candidate payload. No prompt variants, repeated trials, retries or model-based case selection are included. Nine pilot cases count toward the total; the remaining 182 are disjoint. Full completion would mean 764 paid attempts, not 764 independent source cases.

Standard routes and their explicit supported reasoning/cache settings remain in the recorded profiles: Qwen and DeepSeek disable reasoning, Luna requests `none`, and Gemini requests `low`. Provider infrastructure and required settings differ, so results compare those served model configurations rather than isolating architecture from all serving effects. Each retains the 4,096-token completion ceiling, schema validation, disabled fallback and response-cache checks. [Route research](model-qualification-availability.md), [Qwen route research](qwen-flash-qualification-availability.md)

## Sample and labels

The imported original dev split contains 5,334 cases: 3,719 eligible across 183 page families and 1,615 excluded by the existing importer. Before inference, selection chose 200 cases across 40 families, balancing candidate-count bands and lexical instruction cues. Family selection minimized review-text size within each band; this is a diversity-oriented convenience sample, not a random corpus estimate. Candidate pages contain 31–1,069 nodes. Complete candidate values and instructions were reviewed for provider submission; two instructions containing personal contact values were replaced within their families before the frozen final selection.

Nine further cases were excluded before model outcomes: two probable source-label mismatches, four underspecified references, one historical-order uncertainty, one intent/label uncertainty and one workflow-scope limitation. Their original records and reasons remain private. The remaining 191 preserve original instructions and target labels. Source command/page checksums, unique source targets and imported target tags were checked; this establishes provenance, not flawless semantic annotation. The original test split remains untouched.

The retained sample covers 151 distinct source target nodes: 118 anchor, 59 input and 14 button cases. Candidate-count bands `≤100 / 101–250 / 251–500 / >500` contain 35 / 54 / 53 / 49 cases. These are source DOM counts, not inferred action categories. Forty targets have no nonempty text, label or placeholder in the submitted representation; their identity may depend on retained scope or information lost by the text-only import. Such cases remain in the denominator. This sample contains no image, select or textarea gold targets and cannot establish full control-type coverage.

PhraseNode supplies element-selection labels. Its language includes functional, relational and visual references; our sanitized text-candidate representation cannot preserve every original visual cue. Attribution: Pasupat et al., _Mapping natural language commands to web elements_, EMNLP 2018. [Original paper](https://aclanthology.org/D18-1540/), [publisher and dataset licenses](https://nlp.stanford.edu/projects/phrasenode/)

Mind2Web contributes **zero cases to this comparison** under the original-label-only scope. Its imported pilot contains 49 steps, but task-level instructions and gold action descriptions do not provide independent current-step commands. The one previously accepted case used a separately authored adaptation and is therefore outside this comparison. This is a scope exclusion, not a claim that Mind2Web lacks useful data. [Original schema](https://github.com/OSU-NLP-Group/Mind2Web/blob/33bd95caeee7bba22dd08ecc935845e15c5e5dc7/README.md#data-fields), [adaptation research](mind2web-import-feasibility.md)

## Execution and budget

Source revision: `69c3e21`. The private orchestration file `.artifacts/datasets/run-labelled-waves.mjs` freezes the 191-case queue and uses the existing dataset runner and `forecastPilot`. The pilot includes the largest reviewed payload and candidate page. Each subsequent wave takes a contiguous prefix of the remaining queue that fits the reconciled shared **$5 ledger for all four models**, using current bounded route prices and twice the observed per-model input/output maxima from every retained call. Maxima and failures are retained; the formula is not relaxed after a budget rejection. Actual per-call reservations remain authoritative.

Model order rotates between waves; requests run sequentially without retries. The same selected case set reaches every model in a completed wave. If another whole wave cannot fit, execution stops and reports the incomplete frozen plan. Scores never determine which cases run next. Provider identity, response-cache, unique-generation and known-charge checks gate continuation; an invalid or unreconciled call stops further paid work. No paid CI is enabled and the ledger is never reset.

## Evidence and reproduction

Private preparation files live under `.artifacts/datasets/phrasenode-dev-expanded-preparation/`. `labelled-partition-selection.json` records the 9/182 partition, exclusions and parent hashes; its SHA-256 is `858d92742997db25c8bad38375f83cdda5ee15d439b843cc1937ed5a360d71f9`. Exact approved payload hashes live in `labelled-pilot-reviewed-inputs.json` and `labelled-remainder-reviewed-inputs.json`. Wave plans, forecasts and execution records preserve the order and budget decisions. Provider/page payloads stay private.

All four pilot manifests recorded system-prompt SHA-256 `ea2ee6e48dea7838e102281891afe2548f5f9fb2861ed83576f9619168509a32` and schema SHA-256 `04474859d8a35c892a84c81a18a27d68edbfa1d09d04c8f02f8a5f83214ddfe1`. The retained attempted evidence uses those same prompt and schema hashes. Run configuration IDs include the ephemeral loopback proxy address and therefore differ across runs; compare semantic settings after verifying and normalizing only that local address, and verify actual provider request messages and schemas byte for byte.

At the recorded source revision, each retained run can be regraded without services or paid calls:

```sh
rtk pnpm evaluate:dataset --replay .artifacts/datasets/qwen-labelled-pilot
```

Repeat replay for the other model pilot directories and every recorded wave directory. Reissuing a live command would be a new paid experiment, not replay; preserve existing artifacts and budget accounting.

## Results and interpretation

### Paired evidence available before interruption

These 90 cases reached every model once (the 9-case pilot plus the first 81-case wave). Correct means exactly the original labelled singleton target set, with valid complete output; including the gold node among extra targets is insufficient. Provider latency includes all available attempts, not only successes. These are descriptive results on the completed shared subset, not the intended 191-case comparison.

| Model    | Exact responses | Correct below 1 s, provider | Correct within 2 s, provider | Provider p50 / p95, ms | Offline CLI p50 / p95, ms |
| -------- | --------------: | --------------------------: | ---------------------------: | ---------------------: | ------------------------: |
| Qwen     |           64/90 |                        0/90 |                         3/90 |            2809 / 5372 |               3130 / 5698 |
| Gemini   |           74/90 |                        0/90 |                        53/90 |            1628 / 4074 |               1949 / 4392 |
| Luna     |           65/90 |                        0/90 |                        55/90 |            1752 / 2522 |               2072 / 2837 |
| DeepSeek |           67/90 |                       50/90 |                        66/90 |             682 / 1465 |               1005 / 1830 |

Gemini has the highest observed source-target accuracy on this subset; DeepSeek has the most correct results within the provider-time deadline. Neither result establishes a release-quality winner. In particular, the subsequent DeepSeek timeout remains part of the broader evidence, rather than disappearing behind the paired table.

### All attempted work and charges

| Model    | Attempted / planned cases | Exact responses among attempted | Known charges, USD | Charges observed |
| -------- | ------------------------: | ------------------------------: | -----------------: | ---------------: |
| Qwen     |                    90/191 |                           64/90 |       $0.049145998 |            90/90 |
| Gemini   |                   150/191 |                         115/150 |       $0.753512250 |          150/150 |
| Luna     |                   150/191 |                         105/150 |       $0.085750500 |          150/150 |
| DeepSeek |                   134/191 |                          92/134 |       $0.037751850 |          133/134 |

Do not compare these unequal-coverage accuracy fractions as if they used the same cases. There are 240 unattempted model/case pairs. All 524 attempted records remain retained, including the 30-second DeepSeek timeout; no case/model pair was retried. Of them, 523 have unique generation IDs and known provider charges. Requests, source labels and matching-case prompt/schema bytes remain identical across models.

Known new spend is **$0.926160598**, plus one **$0.00651132 reserved amount with unknown actual cost**. The ledger also retains $0.2521110378 from previous experiments: $1.1782716358 known charges and $1.1847829558 including the outstanding reservation, below the unchanged $5 ceiling. The reservation is not reported as an actual charge or silently changed to zero.

The first 81-case-per-model wave passed a conservative $4.65062958 forecast against $4.6624524662 remaining. After reconciliation, the next 60-case wave passed a $4.3361 forecast against $4.3412 remaining. It stopped after Gemini and Luna completed and DeepSeek reached case 44; Qwen's second wave never started. The original interrupted manifest and its 44/60 summary remain unchanged. Resume requires charge recovery and must schedule only never-attempted pairs, retaining the failed case in the denominator.

### Timeout accounting and verification

The offline process timed out before receiving a generation ID. A local deterministic reproduction exposed a shared harness race: a disconnected client's HTTP socket could close while upstream accounting was still pending, allowing shutdown to release the ledger lock too early. The fix waits for active accounting before releasing that lock or saving provider evidence in all three live runners. It validates late evidence after draining while preserving the original result and measured elapsed time. The fix was added after the interruption and has only deterministic regression evidence so far; it cannot reconstruct a response already lost by the original process.

Focused cancellation tests reproduce the original failure and verify late-charge retention, repeated close calls, unchanged timeout outcomes and continued blocking for unresolved charges. The current tooling gate passes 195 tests; Docker configuration and the earlier 66 deterministic browser cases also passed. These engineering checks make no paid inference calls.

The configured inference key cannot access management-only analytics (observed HTTP 403). The supported recovery is to retrieve the matching generation ID from [OpenRouter Logs](https://openrouter.ai/logs), then fetch its exact account charge through the [generation metadata API](https://openrouter.ai/docs/api/api-reference/generations/get-generation). Aggregate balances or activity totals are insufficient to assign a charge to this individual request. Paid work remains stopped while that evidence is missing.

These are **offline single-target selection** measurements. PhraseNode supplies no independent action labels; this run does not evaluate action detection, multiple-target completeness, XPath validity, readiness or historical browser state. Timing includes offline preparation and Resolver child-process startup plus model selection, but no live browser capture or UI round trip. It cannot establish the application's sub-second goal or two-second maximum. Provider prompt-cache warmth remains uncontrolled and must be reported from usage separately from response-cache reuse.

Repeated instructions share page families, development data is already exposed and public-dataset training contamination is unknown. Report family coverage and uncertainty alongside aggregate scores. A wrong match to an uncertain source annotation is not automatically a definite model error; remaining annotation ambiguity requires separate adjudication without rewriting original scores. The controlled browser qualification and its known color-reference gap remain separate evidence.

## Historical threshold reassessment

Regrading the retained 2026-09-30 raw fixture observations reproduces their original correctness counts. Applying policy 2 timing boundaries retrospectively to the 80-attempt confirmation gives:

| Historical profile | Correct | Correct below 1 s | Correct within 2 s |
| ------------------ | ------: | ----------------: | -----------------: |
| Luna baseline      |   75/80 |              0/80 |              73/80 |
| Gemini baseline    |   80/80 |              0/80 |              70/80 |
| DeepSeek baseline  |   75/80 |              9/80 |              62/80 |
| DeepSeek concise   |   74/80 |             74/80 |              74/80 |

None reaches the new 95% deadline requirement (76/80). The concise row is retained historical evidence, not a variant rerun or an improvement claim; its lower correctness is why this comparison does not repeat that rewrite. These authored-fixture timings include capture and validation and must not be pooled with offline source-target timings. Their exposed held-out families now carry regression provenance; original artifacts and the [historical report](model-qualification-report.md) remain unchanged. This reassessment is not fresh qualification.

## Ordered follow-up

[Issue #34](https://github.com/Mochib-Tech-Solutions/xpathed/issues/34) records the accepted second stage: choose one optimization candidate from the completed model comparison, test only failure-supported changes on a frozen development subset, then confirm the selected configuration against the baseline on separate original test families. Existing development baseline attempts are reused rather than repeated. All stages retain the same shared $5 ceiling; no configuration becomes a production default from this offline evidence.
