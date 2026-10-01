# Labelled dataset model comparison

2026-10-01. **Completed all 764 planned attempts: 191 original labelled cases for each of four models.** DeepSeek is the next tuning candidate under the previously frozen correctness-within-two-seconds rule. Gemini has the highest exact source-target accuracy. Qwen is slower and less accurate than Gemini on this sample. No model qualifies for production promotion, and defaults remain unchanged.

## Comparison contract

The declared sample is **191 original PhraseNode development cases from 40 page families**, once per model: Qwen3.8 Flash/Alibaba, Gemini 3.8 Flash/Google AI Studio, GPT-6 Luna/OpenAI and DeepSeek V4.1 Flash/Wafer. All receive the same baseline version-7 system prompt, output schema and per-case instruction/candidate payload. No prompt variants, repeated trials, retries or model-based case selection are included. Nine pilot cases count toward the total; the remaining 182 are disjoint. The 764 attempts represent 191 shared source cases, not 764 independent cases.

Standard routes and their explicit supported reasoning/cache settings remain in the recorded profiles: Qwen and DeepSeek disable reasoning, Luna requests `none`, and Gemini requests `low`. Provider infrastructure and required settings differ, so results compare those served model configurations rather than isolating architecture from all serving effects. Each retains the 4,096-token completion ceiling, schema validation, disabled fallback and response-cache checks. [Route research](model-qualification-availability.md), [Qwen route research](qwen-flash-qualification-availability.md)

## Sample and labels

The imported original dev split contains 5,334 cases: 3,719 eligible across 183 page families and 1,615 excluded by the existing importer. Before inference, selection chose 200 cases across 40 families, balancing candidate-count bands and lexical instruction cues. Family selection minimized review-text size within each band; this is a diversity-oriented convenience sample, not a random corpus estimate. Candidate pages contain 31–1,069 nodes. Complete candidate values and instructions were reviewed for provider submission; two instructions containing personal contact values were replaced within their families before the frozen final selection.

Nine further cases were excluded before model outcomes: two probable source-label mismatches, four underspecified references, one historical-order uncertainty, one intent/label uncertainty and one workflow-scope limitation. Their original records and reasons remain private. The remaining 191 preserve original instructions and target labels. Source command/page checksums, unique source targets and imported target tags were checked; this establishes provenance, not flawless semantic annotation. The original test split remains untouched.

The retained sample covers 151 distinct source target nodes: 118 anchor, 59 input and 14 button cases. Candidate-count bands `≤100 / 101–250 / 251–500 / >500` contain 35 / 54 / 53 / 49 cases. These are source DOM counts, not inferred action categories. Forty targets have no nonempty text, label or placeholder in the submitted representation; their identity may depend on retained scope or information lost by the text-only import. Such cases remain in the denominator. This sample contains no image, select or textarea gold targets and cannot establish full control-type coverage.

PhraseNode supplies element-selection labels. Its language includes functional, relational and visual references; our sanitized text-candidate representation cannot preserve every original visual cue. Attribution: Pasupat et al., _Mapping natural language commands to web elements_, EMNLP 2018. [Original paper](https://aclanthology.org/D18-1540/), [publisher and dataset licenses](https://nlp.stanford.edu/projects/phrasenode/)

Mind2Web contributes **zero cases to this comparison** under the original-label-only scope. Its imported pilot contains 49 steps, but task-level instructions and gold action descriptions do not provide independent current-step commands. The one previously accepted case used a separately authored adaptation and is therefore outside this comparison. This is a scope exclusion, not a claim that Mind2Web lacks useful data. [Original schema](https://github.com/OSU-NLP-Group/Mind2Web/blob/33bd95caeee7bba22dd08ecc935845e15c5e5dc7/README.md#data-fields), [adaptation research](mind2web-import-feasibility.md)

## Execution and budget

The first 524 attempts used source revision `69c3e21`; the 240 resumed attempts used `6c0be5e`. Between them, the shared proxy and runners gained timeout-accounting synchronization and explicit full-reservation review; the offline entrypoint gained evaluation-only prompt-variant support. Rebuilt Resolver/Common binaries therefore have different hashes. The resumed baseline sent the same prompt, schema and per-case inputs: actual provider-request bytes were checked across all models and runs. No baseline prompt or model setting was tuned from results during this comparison. The private orchestration file `.artifacts/datasets/run-labelled-waves.mjs` freezes the 191-case queue and uses the existing dataset runner and `forecastPilot`. The pilot includes the largest reviewed payload and candidate page. Each subsequent wave takes a contiguous prefix of the remaining queue that fits the reconciled shared **$5 ledger for all four models**, using current bounded route prices and twice the observed per-model input/output maxima from every retained call. Maxima and failures are retained; the formula is not relaxed after a budget rejection. Actual per-call reservations remain authoritative.

Model order rotates between waves; requests run sequentially without retries. The same selected case set reaches every model in a completed wave. If another whole wave cannot fit, execution stops and reports the incomplete frozen plan. Scores never determine which cases run next. Provider identity, response-cache, unique-generation and known-charge checks gate continuation; an invalid or unreconciled call stops further paid work. No paid CI is enabled and the ledger is never reset.

## Evidence and reproduction

Private preparation files live under `.artifacts/datasets/phrasenode-dev-expanded-preparation/`. `labelled-partition-selection.json` records the 9/182 partition, exclusions and parent hashes; its SHA-256 is `858d92742997db25c8bad38375f83cdda5ee15d439b843cc1937ed5a360d71f9`. Exact approved payload hashes live in `labelled-pilot-reviewed-inputs.json` and `labelled-remainder-reviewed-inputs.json`. Wave plans, forecasts and execution records preserve the order and budget decisions. Provider/page payloads stay private.

All 764 retained attempts use system-prompt SHA-256 `ea2ee6e48dea7838e102281891afe2548f5f9fb2861ed83576f9619168509a32` and schema SHA-256 `04474859d8a35c892a84c81a18a27d68edbfa1d09d04c8f02f8a5f83214ddfe1`. Run configuration IDs include the ephemeral loopback proxy address and therefore differ across runs; compare semantic settings after verifying and normalizing only that local address, and verify actual provider request messages and schemas byte for byte.

At the recorded source revision, each retained run can be regraded without services or paid calls:

```sh
rtk pnpm evaluate:dataset --replay .artifacts/datasets/qwen-labelled-pilot
```

Repeat replay for the other model pilot directories and every recorded wave/resume directory, using the source revision recorded in each manifest. The private `stage1-final-audit.json` reproduces every per-run summary, and `labelled-comparison-aggregates.json` combines original and resumed attempts without rewriting interrupted runs. `stage2-selected-model.json` freezes the tuning-candidate decision; `stage2-development-baseline.json` references the original 40 development attempts for reuse. Reissuing a live command would be a new paid experiment, not replay; preserve existing artifacts and budget accounting.

## Results and interpretation

Every row covers the same 191 cases from 40 page families, once per model. **Exact responses** require precisely the original labelled singleton target set and valid complete output; returning the gold node among extra targets fails. PhraseNode has no independent action labels, so these scores do not establish correct interaction detection.

| Model    | Exact responses | Correct below 1 s, provider | Correct within 2 s, provider | Provider p50 / p95, ms | Offline CLI p50 / p95, ms |
| -------- | --------------: | --------------------------: | ---------------------------: | ---------------------: | ------------------------: |
| Qwen     |         127/191 |                       0/191 |                        3/191 |            2897 / 4994 |               3224 / 5350 |
| Gemini   |         149/191 |                       0/191 |                      103/191 |            1776 / 4389 |               2088 / 4701 |
| Luna     |         128/191 |                       0/191 |                      107/191 |            1743 / 2513 |               2049 / 2834 |
| DeepSeek |         133/191 |                      65/191 |                      120/191 |            1024 / 2833 |               1328 / 3194 |

Latency percentiles include all available attempts, including failures. DeepSeek has 190 observed provider timings: its original timeout lacks provider elapsed time and remains a failure in every 191-case denominator. All 191 offline elapsed times are available for every model. Correct offline CLI responses within two seconds are Qwen 0, Gemini 57, Luna 50 and DeepSeek 112; below one second they are 0, 0, 0 and 34 respectively.

Raw gold-node matches are 131 / 149 / 133 / 136 for Qwen / Gemini / Luna / DeepSeek. Those are not the exact-response scores above: an extra or otherwise invalid target set cannot become correct because it contains the gold node. Failures include wrong targets, incorrect unsupported/not-found outcomes, extra target sets and malformed or incomplete model output. Model-output contract errors are distinct from provider outages. Original labels and every unsuccessful attempt remain unchanged.

The selection rule was frozen before completion: maximize exact source-target responses within 2,000 ms provider time, then overall correctness, provider p95 and reported cost. **DeepSeek wins that tuning-candidate rule with 120/191**, while Gemini leads overall correctness with 149/191. Neither approaches the 95% correctness/deadline gate, and offline evidence cannot qualify browser behavior. The existing family-diverse 40-case development subset reuses DeepSeek's original attempts (28 exact responses, 25 within two seconds), without rerunning its baseline. No second-stage improvement is claimed here.

### Costs and serving evidence

| Model    | Known provider charges, USD | Charges observed | Reasoning tokens | Cached input tokens |
| -------- | --------------------------: | ---------------: | ---------------: | ------------------: |
| Qwen     |                $0.229897918 |          191/191 |                0 |              98,048 |
| Gemini   |                $1.270649250 |          191/191 |           16,811 |                   0 |
| Luna     |                $0.147707900 |          191/191 |                0 |                   0 |
| DeepSeek |                $0.076895550 |          189/191 |                0 |              78,592 |

Known charges for this comparison total **$1.725150618**. Two DeepSeek timeouts have unknown actual charges and separately consume their complete reviewed reservations: **$0.00651132 + $0.00782268 = $0.014334**. They remain unknown in `reportedUsd`; these amounts are conservative budget accounting, not fabricated provider charges.

At completion of this stage, including **$0.2521110378** from prior experiments, the shared ledger records **$1.9772616558 known charges**, **$0.014334 reviewed reservations**, and **$1.9915956558 total consumed** against the unchanged hard $5 ceiling. There are no unreviewed pending charges; **$3.0084043442** remains. All 762 responses with charges have distinct verified generation identities. The two response-less timeouts do not acquire invented identities, costs or success results. No response reuse was observed; provider prompt-cache warmth is uncontrolled and differs between configurations.

### Interrupted runs and resumption

The first interruption occurred after 524 attempts. Its original DeepSeek wave manifest and **44/60** summary remain unchanged. The user then authorized autonomous resumption under the same hard ceiling, with the unknown charge consuming its full reservation under an explicit review. Only the 240 never-attempted model/case pairs were scheduled.

A second DeepSeek timeout stopped a resumed batch at **42/57**. That original failure and summary also remain unchanged. Its full reservation was reviewed under the same authorization; the last **15 never-attempted cases** ran in a separate directory. No timed-out or completed case/model pair was retried. Independent aggregation confirms exactly 191 unique pairs per model and 764 total attempts, with both timeouts retained as failures.

The first timeout exposed a shared harness race: a disconnected client's HTTP socket could close while upstream accounting was pending, allowing shutdown to release the ledger lock too early. The fix waits for active accounting before releasing the lock or retaining final provider evidence in all live runners; it preserves the original response outcome and elapsed time. This improves accounting, not model correctness, and cannot recover a response already lost by the provider/client timeout. Both unknown costs would require generation-specific provider evidence to replace conservative reservations.

Focused cancellation, reservation and runner checks, the tooling gate, Docker validation and deterministic browser checks passed. These engineering checks remain separate from paid model measurements; no paid CI was introduced.

### Limits

These are **offline single-target selection** measurements. PhraseNode supplies no independent action/readiness/plural labels; this run does not establish action detection, multiple-target completeness, XPath validity or historical browser state. Offline timing includes preparation and Resolver child-process startup plus model selection, but no live browser capture or UI round trip. Provider timing is a narrower measurement. Neither proves the application's sub-second goal or two-second maximum.

Repeated instructions share page families, development data is exposed, serving conditions were uncontrolled across the interrupted run, and public-dataset training contamination is unknown. The sample is not a random production sample; descriptive timing/accuracy differences are not statistical certification. A disagreement with an uncertain source annotation is not automatically a definite model error. Any later adjudication must preserve these original scores. The controlled browser qualification and its known color-reference gap remain separate evidence.

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

[Issue #34](https://github.com/Mochib-Tech-Solutions/xpathed/issues/34) records the accepted second stage and its forthcoming paired report: test only failure-supported changes on the selected DeepSeek configuration using the frozen development subset, then confirm any selected configuration against the baseline on separate original test families. Existing development baseline attempts are reused rather than repeated. All stages retain the same shared $5 ceiling; no configuration becomes a production default from this offline evidence.
