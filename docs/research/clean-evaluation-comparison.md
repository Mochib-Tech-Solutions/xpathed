# Comparison on the audited evaluation set

This report records measurements from **3 October 2026**, before the spatial-item fix. Basic is archived source `d533377945f67f99dbb2d23ab9b2ea04eef61569`; Improved is measured source `77ce7b631d823e2d81dda146e0985158fe8c0e59`; Stagehand is pinned to **4.1.0**. “Improved” names this measured configuration, rather than subsequent versions of `main`.

The README's recorded-comparison table and figure use this report's verified aggregate. Later spatial changes have a [separate two-arm pipeline check](spatial-item-selection.md); Basic, Stagehand and saved-page selection were not remeasured there. Its expanded cases and full-contract score cannot replace these results. A new three-system comparison requires all arms on one frozen collection and grader.

## Dataset and measurement boundaries

| Category                            | Admitted cases | Systems                    | Measurement                                                                                           |
| ----------------------------------- | -------------: | -------------------------- | ----------------------------------------------------------------------------------------------------- |
| Saved-page selection                |            569 | Basic, Improved            | Exact expected target set from reviewed saved candidates; real provider inference                     |
| Live-browser comparison             |            183 | Basic, Improved, Stagehand | Correct action and exact target set on reset controlled browser pages; real provider inference        |
| XPath construction and verification |            172 | Recorded Browser           | Controlled selections, independently labelled DOM targets and saved-locator mutations; no model calls |

The saved-page archive contains only the 569 admitted PhraseNode cases across 171 historical page families: 542 dev, 24 test and three train. All 515 excluded source records remain in the audit: 288 have insufficient evidence, 218 are ambiguous and nine have contradictory expectations. The original 1,084-case archive remains available for provenance. Exclusions were fixed before these runs; model failures do not remove cases from the denominator.

The browser catalog also contains controlled provider-failure and mutation cases that do not belong in a paid model comparison. Category selection records those exclusions explicitly. XPath evaluation requires a selected target and omits cases with no XPath to construct. These are different measurements, so their denominators are never pooled. The [evaluation guide](../evaluation.md) defines the categories and graders.

## Results

| System            | Saved-page target selection | Browser action + targets |
| ----------------- | --------------------------: | -----------------------: |
| Basic resolver    |             501/569 (88.0%) |          161/183 (88.0%) |
| Improved resolver |             498/569 (87.5%) |          172/183 (94.0%) |
| Stagehand         |              Not applicable |          114/183 (62.3%) |

![Recorded accuracy on the frozen audited dataset](../assets/evaluation/clean-comparison.svg)

Basic → Improved: **13 gains and 2 regressions** in browser action-and-target correctness; **36 gains and 39 regressions** in saved-page exact selection.

### Browser scoring boundaries

| System            | Action + targets | Target selection only | Full resolver contract |
| ----------------- | ---------------: | --------------------: | ---------------------: |
| Basic resolver    |  161/183 (88.0%) |       161/175 (92.0%) |        147/183 (80.3%) |
| Improved resolver |  172/183 (94.0%) |       171/175 (97.7%) |        158/183 (86.3%) |
| Stagehand         |  114/183 (62.3%) |       148/175 (84.6%) |         Not applicable |

The common score checks the action and complete target set, with passive-state and privacy checks. The target-only denominator excludes eight explicitly unsupported instructions. It checks exact targets or scoped absence without requiring the action name. The full resolver score additionally checks readiness, capture coverage and outcome details; Stagehand does not expose that contract.

Controlled XPath verification passed **172/172**, with **22/22** saved-locator mutations and **22/22** fresh resolutions after mutation. This category makes no model calls.

### Browser behavior categories

| Behavior    |         Basic |       Improved |     Stagehand |
| ----------- | ------------: | -------------: | ------------: |
| appearance  |  5/5 (100.0%) |   5/5 (100.0%) |   3/5 (60.0%) |
| cardinality |   2/4 (50.0%) |    2/4 (50.0%) |   2/4 (50.0%) |
| context     | 50/53 (94.3%) | 53/53 (100.0%) | 49/53 (92.5%) |
| frames      |  3/3 (100.0%) |    2/3 (66.7%) |   1/3 (33.3%) |
| robustness  |  3/3 (100.0%) |   3/3 (100.0%) |   1/3 (33.3%) |
| scope       | 19/25 (76.0%) |  23/25 (92.0%) | 17/25 (68.0%) |
| state       | 46/56 (82.1%) |  50/56 (89.3%) | 14/56 (25.0%) |
| targeting   | 33/34 (97.1%) | 34/34 (100.0%) | 27/34 (79.4%) |

### Calls and cost

| Category / system              | Original calls | Known reported USD | Unreported charges |
| ------------------------------ | -------------: | -----------------: | -----------------: |
| Browser / Basic resolver       |            183 |        $0.01728245 |                  0 |
| Browser / Improved resolver    |            183 |        $0.01856919 |                  0 |
| Browser / Stagehand            |            183 |        $0.01675343 |                  1 |
| Saved-page / Basic resolver    |            569 |        $0.36691782 |                  0 |
| Saved-page / Improved resolver |            569 |        $0.37063518 |                  1 |

Total: **1,687 original calls**, **$0.79015806 known reported cost**, plus **2 unknown charges**. Unknown amounts are not counted as zero. No failed provider attempt was retried or replaced.

### Timing by execution cohort

| Category / system              | Cohort                     | Measured / attempts | Median |    p95 |
| ------------------------------ | -------------------------- | ------------------: | -----: | -----: |
| Browser / Basic resolver       | original-parallel          |             183/183 | 0.851s | 1.909s |
| Browser / Improved resolver    | original-parallel          |             183/183 | 0.865s | 1.815s |
| Browser / Stagehand            | original-parallel          |             158/159 | 0.819s | 2.126s |
| Browser / Stagehand            | stagehand-continuation     |               24/24 | 0.911s | 1.609s |
| Saved-page / Basic resolver    | parallel-arms              |             129/129 | 1.667s | 6.012s |
| Saved-page / Basic resolver    | parallel-arms-continuation |             440/440 | 1.435s | 2.569s |
| Saved-page / Improved resolver | parallel-arms              |             128/128 | 1.625s | 5.868s |
| Saved-page / Improved resolver | parallel-arms-continuation |             441/441 | 1.462s | 2.478s |

### Case examples

The two browser regressions remain explicit:

- `scope-offscreen-alert-archive-is-absent`: Basic correctly reported absence; Improved selected a visible control for an off-screen Archive request.
- `frames-target-in-nested-named-frames`: Basic selected Submit inside Payroll inside Employee; Improved selected a main-page control. Stagehand found the nested target.

All case-level outcomes and complete browser/saved-page gain and regression lists are in the public aggregate. Saved-page instructions remain in the private input archive.

## Matched conditions

All paid arms use DeepSeek V4.1 Flash through OpenRouter's Wafer provider, reasoning disabled, provider fallback disabled and a 4,096-token output allowance. Each case has one original attempt per system, without retries or response reuse. Operational and model-output failures count as failures; missing charges remain unknown.

Basic and Improved receive identical saved-page instructions and candidates, with identical independent expectations and prepared-input hash bindings. Basic retains its historical saved-page prompt; its browser path uses its archived current-view prompt. The measured Improved resolver shares one prompt across both categories. Configuration identities are therefore checked within each category, not forced to match across categories. Browser arms receive the same instruction and reset fixture state, with matching viewport and Chromium binary, and prepare their own model inputs. Stagehand uses stock `observe` and its own snapshot, prompt and selector generation. Singleton grading checks its first suggestion; plural grading checks its whole returned set. No arm executes the requested user action.

Basic uses its original archived Browser and Resolver images. A private request-envelope adapter supplies the archived current-view contract selector; it leaves the native response and provider request unchanged. Provider-free checks verified singleton, plural and scoped-absence behavior before inference. The measured Improved resolver uses the same pinned image for the browser and saved-page measurements. The application retains one implementation.

The browser run began with three isolated streams. After a retained Stagehand response-body timeout, only its 24 unattempted cases continued in a separate timing cohort. Saved-page arms run concurrently in two isolated streams, each serial within its own arm. After a retained HTTP 429, their remaining attempts continued without retrying that case; original and continuation timings remain separate. Timing includes that execution environment and is reported separately by category and cohort. Saved-page timing measures the Resolver CLI inference process, excluding preparation; browser timing measures each resolver or observer request. Neither is a clean serial latency benchmark.

## Evidence and reproduction

Measured on 3 October 2026. The measured Improved runtime source is `77ce7b631d823e2d81dda146e0985158fe8c0e59`; Basic uses archived source `d533377945f67f99dbb2d23ab9b2ea04eef61569`. XPath ran at `733eaccd6b678b64c79e4d833a9dc9ebda297a73`, with the same Browser runtime and case definitions. Changes through report publication repaired comparison failure handling and published the report; later source changes, including spatial-item capture, are outside these measurements.

| Evidence            | Run ID                                 | Manifest SHA-256                                                   |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| Browser comparison  | `11a3980b-c5af-4f8d-9f47-54a9887905ff` | `40070f1c74ae42a05c2d46b7a0b1c3d0e5d43941db47f7f553aaf6a910fec242` |
| Saved-page Basic    | `ba2e00d1-1f88-4250-a0d8-7ccb7134a9fb` | `017059fa376e7a2806940630171323679b06cf5b64f3be074f9a1172c3ad304a` |
| Saved-page Improved | `fa36f280-569f-4610-bc93-7d19b0076d49` | `a1c1c7f1d97f2fcf67195c2f065fb4f6f14d28ba7b2ca7ec47e7f852b6a61e2f` |
| XPath verification  | `127b1056-90af-4aa6-816c-82a2c5e6c9e7` | `ca0a2871fa73f058b53000abc19c4f3de0febf48185f3865ecdc420d1a9436c5` |

The active input archive SHA-256 is `ca9c2dd8e5fbf5a6bc48b80fcc863113eff771f9a726858f3f9386f2a39080ae`; the full label-review SHA-256 is `f7233682af26dd85c34d1904504cf9542454a398a318ffc3d0738cd0c8fa5fbb`. The saved-page plan content hash is `901eb49ed544226c14aa4d0a32db477c67c0e9fa313aabd939e56a6cbb4c32c3`. The run manifests and public aggregate retain source/image identities, settings and exact case membership. Private trial and preparation evidence retains the prompt/schema bindings; public receipt and trial hashes bind that evidence.

Browser continuation receipt: `cd40e05c610dd71e78bfc645743195c108c0d45febb996538e00d71012b24645`. Saved-page continuation receipt: `ae7a33e8d48eeb913ff5a7a5658f9490afb62cc749118f55819814cc039aa1d8`. Original trial and provider files remain bound by these receipts; the public aggregate also records the exporter and current verifier hashes.

The [public aggregate](../assets/evaluation/clean-comparison.json) contains case identities, original trial hashes, failures, paired gains and regressions, costs, configuration settings and source/image identities. Raw page inputs and provider payloads remain private. The [figure instructions](../assets/evaluation/README.md) describe regeneration from complete saved evidence without another provider call.

The active archive and full semantic review are pinned in [collection.json](../../evaluation/datasets/collection.json). The [final admission audit](2026-10-03-contract-admission-audit.md) explains the final membership. The original source archive and prior reports remain historical evidence; their scores are not substituted for these measurements.

### Retained setup and continuation evidence

An initial saved-page setup supplied an empty user-message template to the request guard. All 149 local requests were rejected before external forwarding; their evidence remains in a separate failed setup archive, with zero external model calls. The corrected launcher was checked against both actual Resolver images through a local fake provider, including rejection of changed input, prompt and schema. Those local setup checks are not model-accuracy measurements.

The measured browser run retained its response-body timeout as a failed attempt with an unknown charge. The corrected timeout guard was also checked against completed malformed responses, which remain fatal. Its continuation copied all 525 original attempts unchanged and ran only 24 previously unattempted Stagehand cases.

The saved-page continuation copied 257 original attempts unchanged and ran only the remaining 881 planned attempts. Its HTTP 429 remains a failure with an unknown charge. The public aggregate binds both continuations to their original plans, file hashes, source/image identities and distinct timing cohorts. No case definition, expected target or original provider attempt was replaced.

## Limits

The label review included earlier observed failures, so these are audited evaluation-set measurements, not a blinded held-out estimate. Controlled browser pages test authored behaviors; imported historical pages add language and page variety but cannot establish live viewport, XPath or readiness correctness. One attempt per case leaves sampling variation unresolved, and the hosted model can change independently of the recorded model name.

The comparison measures complete configurations. It does not isolate the causal contribution of each prompt or browser change. A higher aggregate score does not override lost baseline passes or establish release approval, deployment or unseen-site accuracy.
