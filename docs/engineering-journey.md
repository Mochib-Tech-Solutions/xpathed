# Building confidence in an XPath resolver

“Click Save” sounds simple until a page has three Save buttons, one hidden copy and a disabled control. A model can return a valid XPath for the wrong one. The engineering problem is to establish what the user meant, what the browser actually contains and what evidence supports the answer.

xpathed was built for the the test platform internship case study: a working natural-language-to-XPath prototype, an explained architecture, an evaluation strategy and a deployment pipeline. This article follows the decisions and experiments behind it. For the request flow, start with [how the system works](how-it-works.md); for commands, use the [evaluation](evaluation.md) and [release](releases.md) runbooks.

The measurements below are historical observations from **September 30–October 1, 2026**. Each linked report retains its own source revision, configuration, limitations and evidence references. They are not a benchmark of today's hosted models or a score for the current application.

## First, make the answer checkable

The core decision was to divide the work. The model interprets the instruction and selects captured candidate identities. Browser code constructs an XPath and checks that it uniquely identifies the selected node in the correct frame. The model never needs to invent an XPath. [ADR-0002](adr/0002-select-elements-before-generating-xpath.md) records the choice.

This creates two different questions:

1. **Did the model select the intended element?** Only an independently defined expected target can establish that.
2. **Does the XPath identify that selected element?** The live browser can check uniqueness and node identity directly.

Passing the second check cannot answer the first. Likewise, finding a disabled Save button can be correct even though clicking it is currently unavailable. The result must preserve that distinction.

The prototype resolves one action across one or more targets in the current view. It highlights those targets and reports observed readiness; it does not execute the instruction. Keeping execution separate makes the contribution measurable and avoids calling a successful locator check a successful test. [ADR-0001](adr/0001-separate-resolution-from-execution.md) and [ADR-0018](adr/0018-scope-resolution-to-the-current-view.md) explain these boundaries.

## Build a grader that can disagree with the resolver

Consider “Click all Approve buttons in Pending.” If three buttons belong to that section, returning two correct buttons fails completeness. Returning those three plus an Approve button in History also fails. A disabled intended button remains part of the expected set, with its state reported separately.

Controlled browser fixtures define the expected nodes independently. Their test-only oracle receives the expected mappings after capture and inference and keeps them out of model-visible DOM attributes and text. It evaluates the returned XPath in its frame and compares the resulting node with the expected node. See the [oracle](../evaluation/fixtures/oracle.js) and [grader](../evaluation/grader.mjs).

| Check                                    | What it catches                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Capture and model-input coverage         | The intended node was lost before the model could choose it.                                  |
| Intended target and unique XPath match   | The answer points to the wrong node, several nodes or no node.                                |
| Exact target set                         | A plural answer contains missing, extra or duplicate targets.                                 |
| Action and response contract             | The target is right but the interaction or result structure is wrong.                         |
| Scope, absence and completeness          | A viewport miss is mistaken for page-wide absence, or incomplete processing looks complete.   |
| State and readiness                      | A found but disabled, readonly or covered control is described incorrectly.                   |
| Privacy, label leakage and passive state | Protected values or expected answers leak, or resolution changes scroll, focus or form state. |

Two modes serve different purposes. **Deterministic evaluation** supplies controlled provider responses to test the pipeline and grader. **Live evaluation** calls the real configured model to measure its selections. A green deterministic run is engineering evidence, not an LLM accuracy score.

### Check the locator again after the page changes

Initial correctness does not establish durability. Mutation cases insert wrappers and siblings, change classes or IDs, add duplicates, rerender controls and remove or replace targets. They measure both reuse of the saved XPath and a fresh resolution after the change.

These checks found real problems: the September 30 Stagehand study retained failures for ID renaming and a different control replacing the original under the same ID. Fresh resolution passing did not excuse saved-locator failure. The subsequent [semantic XPath work](research/2026-10-01-semantic-xpath-reuse.md) informed the current strategy, which prefers explicit test contracts and meaningful semantic scope before ordinary IDs. The [selection policy](resolution.md#preferred-xpath) remains the precise contract; mutation coverage is evidence for those tested changes, not a promise that an XPath survives every redesign.

## Learn from public data without inventing missing labels

Authored fixtures give precise browser expectations but are easy to overfit. External data adds language and page variety. xpathed imports two sources with different limits:

| Source     | Useful evidence                                                                     | What it cannot establish here                                                                   |
| ---------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| PhraseNode | Original commands paired with source target nodes; preserved train/dev/test splits. | Historical viewport, live XPath identity, action readiness or plural completeness.              |
| Mind2Web   | Task, action and target provenance for studying web interactions.                   | An independent current-step instruction without a reviewed adaptation of the task-level source. |

The [initial import report](research/external-dataset-pilot-report.md) accounts for 51,663 PhraseNode commands, of which 36,404 were eligible for offline selection under that importer. This is source accounting: it does not mean every eligible command was sent to a model. A 49-action Mind2Web pilot yielded one independently reviewed adaptation; it was not a full-corpus benchmark.

The later four-model comparison used **191 reviewed PhraseNode development cases from 40 page families**. Mind2Web contributed zero cases to that original-label-only comparison. The expanded baseline used **860 reviewed cases from 180 families**, after review exclusions and deduplication. Raw page inputs remain private; manifests preserve checksums, original IDs, splits and review decisions.

**No model was trained or fine-tuned in this project.** The work evaluates pretrained models and experiments with prompts and context. Repeatedly inspecting a dataset makes it regression/development evidence. Its original “test” label does not make it untouched again, and unknown pretraining exposure prevents a strong contamination-free claim. Current release evaluation therefore reports regression behavior rather than claiming unseen-web generalization.

## Choose a model by a declared decision rule

The useful question was which configuration could return correct targets quickly enough for interactive test authoring. Comparisons recorded the model, serving provider, reasoning settings, prompt, output schema, token allowance and candidate representation. Provider fallback and response reuse were disabled. Prompt-cache behavior was recorded because it can affect both latency and cost.

### 1. Controlled browser cases exposed a representation gap

On September 30, the [fast-model comparison](research/model-qualification-report.md) tested Luna, Gemini, DeepSeek and a concise DeepSeek prompt. The confirmation phase contained 40 cases with two attempts each per configuration. Gemini passed **80/80**, compared with **75/80** for Luna and baseline DeepSeek and **74/80** for concise DeepSeek.

None qualified under that experiment's frozen policy. A development case described a target by color, while the captured context lacked computed color evidence. Gemini's perfect confirmation score did not repair that known gap. The pilot and confirmation together reported **$0.2386679412** in charges. Those old thresholds and repeated holdout phases belong to the historical experiment, not today's release workflow.

### 2. Original target labels separated accuracy from speed

The October 1 [labelled comparison](research/labelled-model-comparison-report.md) ran each of four configurations once on the same 191 cases:

| Served configuration                | Exact target responses | Correct within 2 s of provider time | Known charges, USD |
| ----------------------------------- | ---------------------: | ----------------------------------: | -----------------: |
| Qwen3.8 Flash / Alibaba             |                127/191 |                               3/191 |       $0.229897918 |
| Gemini 3.8 Flash / Google AI Studio |                149/191 |                             103/191 |       $1.270649250 |
| GPT-6 Luna / OpenAI                 |                128/191 |                             107/191 |       $0.147707900 |
| DeepSeek V4.1 Flash / Wafer         |                133/191 |                             120/191 |       $0.076895550 |

Gemini had the highest exact accuracy. DeepSeek won the predeclared tuning rule: maximize correct responses within two seconds, then use accuracy, tail latency and cost as tie-breakers. That selected a next experiment; it did not establish a universally best model or approve a production default.

The comparison retained all **764 attempts**. Known charges totaled **$1.725150618**; two DeepSeek timeout charges remained unknown. Their **$0.014334** combined reserved maximum was conservative campaign accounting, not a reported provider charge. Provider time also excludes browser capture, verification and UI delivery, so this table cannot establish application response time.

### 3. Keep a prompt change only if the evidence supports it

Failure inspection suggested that the model sometimes expanded a singular instruction into several alternatives. An `intent-cardinality` prompt clarification improved a 40-case development screen. On 30 separately frozen confirmation cases, however, exact correctness changed from **24/30 to 23/30**, and correct provider responses within two seconds from **22/30 to 21/30**.

The [prompt experiment](research/labelled-prompt-comparison-report.md) therefore retained the baseline. Its 100 new calls cost **$0.03614465**. The sample supports that predefined decision, not a statistical claim that the wording is always worse. A negative result was useful: it prevented an appealing change from being adopted on development scores alone.

### 4. Broader coverage revealed where the representation struggles

After an interrupted Wafer run, a separately authorized DeepInfra FP8 run completed all 860 reviewed requests with the same model and baseline prompt. It returned **547/860 exact responses (63.60%)**, with **$1.618648388** in reported charges and no transport or billing failures. There were still **49 output-contract errors**.

The [expanded report](research/deepinfra-labelled-baseline-report.md) separates targets with a name in serialized context (**495/657 correct**) from those without one (**52/203**). That association points toward context and naming as useful investigation areas; it does not isolate one cause. Its offline timing included process startup and remote accounting, so it cannot be presented as browser latency. The changed cohort also prevents treating 547/860 versus 133/191 as a model regression.

The checked-in application defaults remain DeepSeek/Wafer in [.env.example](../.env.example). Experimental DeepInfra use and a recommendation for the next evaluation are separate from runtime configuration and the approved release record.

## Improve context before adding another model call

The browser originally captured eligible page-wide candidates. The current workspace instead targets the visible viewport, retaining partially visible, disabled and covered targets and useful context. Bounded CSS color and geometry evidence support references the earlier representation could not express.

In the [October 1 paired browser study](research/viewport-baseline-report.md), the **12 pairs whose intended targets stayed unchanged** used **35,635 → 15,966 input tokens**, a **55.20% reduction**. Correct complete commands changed from **12/12 to 11/12**. Scope-changing and color cases were reported separately; across all 16 cases, current-view correctness was **14/16** versus **15/16** for the legacy arm. Smaller input alone was not a quality win.

The original run also exposed a measurement mistake: remote accounting writes consumed the former two-second response deadline. Its failures were kept, then a corrected protocol moved bookkeeping outside the measured Resolver interval. The later [latency decision](adr/0020-treat-latency-targets-as-evaluation-metrics.md) removed the total two-second cutoff: a slow correct response now remains useful and counts as a missed speed target.

An optional Jev classifier then tested whether one extra call could decide when to omit appearance or layout fields. In the [metric-only paired experiment](research/jev-context-comparison-report.md), every classifier answer triggered the conservative fallback, so **no optional evidence was removed**. Control passed **14/16** cases; assisted resolution passed **13/16**, with median Resolver HTTP time **1,000.59 → 1,505.49 ms** and reported cost **$0.0009731344 → $0.0012836404**. The assisted path remains evaluation-only. Its provisional questions and thresholds did not earn the extra request.

## Compare an existing tool fairly

The [Stagehand 4.1.0 pilot](research/stagehand-comparison-report.md) compared observation-only resolution using the same model route and controlled browser state. It checked Chromium identity, documents, viewport, language, timezone and initial page state before inference. Each strategy retained its own prompt and representation.

The final 12-case run passed **11/12** for xpathed and **12/12** for Stagehand. xpathed found the correct Save button but interpreted “press” as the wrong action. An earlier two-repeat run retained five Stagehand truncated-output failures. All **74 paid calls** across compatibility and comparison runs cost **$0.0128587224**.

This is evidence that an existing framework is a credible alternative, with trade-offs worth measuring. The small, exposed, click-only sample and run-to-run variation do not establish a winner. Singleton grading uses the first suggestion; plural grading uses the entire target set. Readiness observations that Stagehand did not expose remain unavailable.

## Turn experiments into a repeatable release decision

[![Release evaluation: ordinary CI, a complete candidate-versus-approved comparison, verified approval, explicit activation and nightly monitoring](diagrams/evaluation-release.svg)](diagrams/evaluation-release.svg)

The [current design](adr/0023-simplify-release-evaluation.md) simplifies the earlier sequence of pilot and holdout gates. It uses one policy and one shared collection grouped by behavior:

1. Feature PRs into `main` run ordinary provider-free CI, including the affected unit, integration, UI and deterministic browser checks.
2. A trusted `main` → `release` PR compares exact candidate images with the approved baseline on every eligible browser case and reviewed imported case. Both arms use the same frozen inputs and current policy, with one original attempt per case and no automatic retries.
3. Approval requires **no lost baseline pass**, complete evidence and valid safety, contract and artifact checks. New gains cannot cancel an existing regression. Browser and offline scores retain separate denominators.
4. Merge-time verification selects the tested images only if the source tree and baseline still match. Local activation is explicit; merging does not deploy into the maintainer's Docker daemon.
5. Nightly monitoring repeats the approved live collection against its saved measurements. It reports lost passes and operational failures without changing approval or the running application.

Latency and cost are descriptive under the current policy. Missing billing metadata stays unknown; actual provider failures and missing required results still fail evaluation. Existing semantic failures remain visible, and equality can pass. This policy protects known behavior; it is not an absolute production-quality threshold.

The implementation preserves the existing `v1.0.0` approval and its archived runner during migration. The runbooks record publication and digest verification of the reviewed private dataset. They also explicitly leave verification of the new hosted release-PR flow, complete live comparison, merge-time approval and activation as separate operational outcomes. This article makes no claim that those steps were exercised by this documentation change. [Release operations](releases.md) describes the checks and remaining boundaries.

### What reproduction means

A run preserves source and image identities, model/provider settings, prompt and schema, frozen cases, independent labels, every original outcome, timings and available charges. Failed and interrupted runs keep their identities; later diagnostic runs do not replace them.

Offline replay regrades saved evidence without another provider call. It cannot recreate a historical website or force a hosted model to reproduce its answer. Historical reports must be replayed at their recorded revision because commands, policies and layouts have changed. [Evaluation commands and retention](evaluation.md) cover current usage; private page evidence is kept separately from durable source/image identity and approval history.

## What this means for a test-automation team

For leadership, the useful explanation is concrete: a tester writes “Approve every pending invoice,” sees the intended controls highlighted and receives one checked locator per target. When the system lacks evidence, it says what is missing. Product value should be assessed through authoring time, correction effort and wrong-target suggestions, alongside latency and cost. Those business outcomes have not been measured in this prototype.

The next steps should follow observed failures:

| Proposed next step                                             | Why it is worth testing                                                          | Evidence needed before adoption                                                                                          |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Diagnose unnamed and relational targets                        | The expanded source sample showed a large naming gap.                            | Reviewed failure categories and a paired context experiment without losing current passes.                               |
| Study real authoring sessions with consented, sanitized inputs | Controlled fixtures and convenience samples do not represent all customer pages. | Independent target labels, correction rates and measured authoring time.                                                 |
| Offer reviewed locator-repair suggestions                      | Mutation cases already distinguish reuse from fresh resolution.                  | Preserved original failures and proof that a suggested repair targets the intended control without weakening assertions. |
| Add execution as a separate integration                        | A test runner needs an action result and postcondition beyond a locator.         | An explicit execution contract, browser ownership, isolation and independent success checks.                             |
| Explore test drafting and failure triage                       | The same target evidence could reduce repetitive authoring and diagnosis.        | Requirement-based assertions and outcome grading, with human review before changing a test.                              |

These are proposals, not implemented capabilities. The immediate integration boundary is already useful: a consuming test platform can request a resolution for a managed page and receive a target, frame context, verified XPath and observed limitations. Production tenancy, authentication, scaling and customer-data requirements need their own design before exposing the local workspace as a hosted service.

The potential advantage is a growing body of reviewed examples and explainable failures: which instructions resolve correctly, which page changes invalidate locators and which changes improve measured behavior. The project's strongest result is the ability to distinguish a plausible answer from a checked answer—and to preserve evidence when an experiment fails.
