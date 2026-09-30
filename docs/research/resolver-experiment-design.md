# Resolver experiment design

Research checked on 2026-09-30. This remains a proposed model/prompt comparison design, not an implemented matrix runner. The subsequently approved initial experiment has a shared $5 ceiling and uses standard serving only; those limits apply across attempts and configurations, not per run. No paid calls were made. The user's current priority is speed, then target-resolution quality, then cost; low token price does not establish a suitable production model.

Subsequent steering: the maintainer supports the proposed total ceiling and explicitly excludes fast/priority service tiers. Plan around the proposed $5 total for the initial experiment across all models, variants and attempts. This ceiling is not yet enforced by the existing live command; a concrete manifest and spending guard must precede paid execution. Future CI or scheduled runs do not inherit an automatically replenished $5 allowance.

## Recommendation

Use a small paired screening experiment, then spend additional examples only on promising configurations. Keep a hard correctness floor before ranking speed. Optimize the winning configuration's prompt and DOM representation separately, then compare that frozen system with the incumbent on an untouched final set. Do not run every model, prompt and DOM variant across the complete corpus.

This borrows the resource-allocation idea from [Hyperband](https://www.jmlr.org/papers/v18/16-558.html): allocate more evaluation effort to promising configurations. It does not claim to implement Hyperband or inherit its theoretical guarantees. Our stages are fixed, reviewable sample sizes; early scores guide engineering rather than proving statistical superiority.

## Decide what can win

Two different decisions need separate criteria:

1. **Eligibility to compete:** no failure of required identity, privacy, isolation or response-contract gates; a declared minimum intended-target/action accuracy; and no unacceptable regression in critical categories. Do not average a severe contract defect away with easy successes. The semantic floor and acceptable regression margin need a product decision; they are not secretly selected after seeing scores.
2. **Ranking eligible systems:** lowest end-to-end time to a usable, same-node-verified result; then higher intended-target/action correctness when speed differences are practically indistinguishable; then lower cost. Declare the meaningful latency difference before running so measurement noise does not select a winner.

Report the fraction of all attempts that are both correct and complete before a declared deadline, alongside success rate and latency. This prevents an instantly wrong answer from winning and exposes a slow tail. Show p50/p95 for all completed requests and successful requests separately, plus timeout/error counts; never hide failures by timing only successes. A small pilot's p95 is descriptive and unstable, not a latency SLO proof. Offline-selection cases cannot claim the browser verification component of this metric.

The distinction between first-attempt success and repeated reliability follows [Anthropic's evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents). Retain every trial; report first attempts and repetitions independently. An eventual success after retry does not replace an original failure.

## Proposed bounded stages

Counts below are illustrative ceilings for one experiment, not a claim that enough suitable independent cases already exist. They can be reduced to fit a monetary cap once actual route/token measurements exist.

| Stage                     |                                                   Calls at most | Purpose                                                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic preparation |                                                0 provider calls | Validate mappings, capture coverage, graders, privacy and manifests locally; fix broken cases before paying to evaluate them                                                                                           |
| Model screening           |                         3 configurations × 24 shared cases = 72 | Use the accepted three-model shortlist; reject obvious incompatibility and grossly inadequate results                                                                                                                  |
| Extend finalists          |                                   2 × 76 additional cases = 152 | Bring two survivors to 100 shared development cases each; reuse their first 24 original outputs                                                                                                                        |
| Prompt/DOM experiments    | 2 variants plus unchanged baseline × 40 development cases = 120 | Test separately defined changes on the leading model with a freshly interleaved unchanged control; saved baseline outputs can support quality diagnosis but do not substitute for contemporaneous latency measurements |
| Frozen confirmation       |                                 2 systems × 100 new cases = 200 | Compare incumbent and final challenger, including the selected prompt/DOM settings, on an untouched set                                                                                                                |
| Reliability spot check    |                2 systems × 10 fixed cases × 2 extra trials = 40 | Check instability without repeating the entire suite; these are repetitions, not 40 new independent examples                                                                                                           |

This example totals **584 paid requests**, plus any separately declared warmups. It is an upper request count for those stages, not a dollar cap or a requirement to run every stage. Stop earlier when the answer is clear enough for the engineering decision or the budget is exhausted; an inconclusive result is valid. Do not promote a system if evidence cannot establish the required correctness floor.

The 24-case stage is a smoke screen, not a benchmark ranking. Retain plausible contenders when observed gaps are small; do not prune merely to force two finalists. If uncertainty requires a third survivor, either redistribute the remaining declared budget, revise the experiment visibly, or stop inconclusively. Never silently exceed the plan.

Use representative strata for both datasets, action types, page sizes and difficult categories. Preserve source split labels. Balance stress cases separately from representative traffic so a challenge-set score is not mistaken for production accuracy. Keep related pages, tasks, templates and mutations in one family, and allocate whole families to development or confirmation. If 100 independent held-out families cannot be obtained and reviewed, state that limitation instead of relabelling familiar cases as holdout.

## Natural instruction coverage

The maintainer explicitly requires diverse everyday instructions, including “click on the about us link” and “click on the button above the red button.” Build a versioned case bank before selecting the small paid screening sample. The bank should cross instruction wording with page structure and action intent, rather than count many trivial paraphrases as independent coverage.

| Family                                   | Example instructions                                                                                                                         | What must be independently checked                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Direct label and paraphrase              | “Click on the About us link”; “Open About us”; “Go to the About us page using its link”                                                      | Same intended link and click action when the link exists; distinguish element-directed wording from unsupported URL-only navigation |
| Informal wording and typos               | “pls click about us”; “clik the search button”; “could you select the country dropdown?”                                                     | Preserve intent without requiring exact label matching; genuinely ambiguous wording stays distinguishable                           |
| Semantic context and duplicates          | “Click Save in Billing”; “Open Details for the second invoice”; “Click About us in the footer”                                               | Correct section, row, order and scope instead of the first matching label                                                           |
| Spatial relationships                    | “Click the button above Cancel”; “Select the field to the right of Country”; “Click the leftmost Buy button”                                 | Rendered relationships, including CSS order differing from DOM order, nested scrolling and viewport changes                         |
| Appearance and anchor combinations       | “Click the red button”; “Click the button above the red button”; “Click the outlined button beside the trash icon”                           | Actual appearance evidence, correct anchor, correct related target and no target-label shortcuts                                    |
| Action distinctions                      | “Hover over Help”; “Double-click the item”; “Replace the search text”; “Type into Search”; “Uncheck Remember me”; “Select France in Country” | Requested action as well as the intended target; fill/type and click/check are not interchangeable                                  |
| State and eligibility                    | “Click the disabled Submit button”; “Click the lower Save button”; “Click the covered Continue button”                                       | Find an eligible existing target while reporting its observed limitations; hidden-only matches remain distinct                      |
| Plural targets and unsupported workflows | “Click every Remove button in the cart”; “Fill Email and check Remember me”; “Click Login, then fill the field that appears”                 | Complete same-action target sets; mixed interactions and sequential workflows unsupported as a whole, without execution             |
| Missing and ambiguous references         | “Click Export” when absent; “Click that button” with no referent; “Click the button above the red button” with two indistinguishable anchors | Appropriate absence or ambiguity; no arbitrary first-match success                                                                  |

For each family include clear positive examples, plausible distractors and selected cases with missing or ambiguous referents. Change positions, labels and colors independently so incidental DOM order, a CSS class named `red`, or text naming the expected answer cannot solve an appearance case accidentally. Use controlled fixtures for these counterexamples where external datasets lack reviewed labels. Keep a literal reference to a quoted label distinct from a description of appearance.

As inspected on 2026-09-30, `CandidateSelectionStrategy.PrepareInput` sends labels, text, structural scope, target state, frame labels and candidate geometry, but no computed colors or appearance descriptors. Geometry supplies some spatial evidence; it does not establish tested relational accuracy. Color-anchored cases therefore expose a current representation gap. Record that gap explicitly, and evaluate any added compact appearance representation as a separate implementation/configuration change. Do not claim support, invent appearance from labels, relabel a required capability as passing unsupported, or add screenshot input silently. Historical dataset geometry and missing reference anchors must likewise remain explicit limitations.

A small screening sample should touch each available instruction family; it is not the complete coverage suite. Preserve case IDs, family quotas, seeds and selection rationale before inspecting model scores. Broader deterministic checks and later budgeted confirmation provide additional coverage. Original paraphrases, distractor variants and mutations remain in the same split.

### One action across multiple current-page targets

The latest accepted basic scope is one interaction per command, applied to one or more distinct targets. The workspace now uses contract version 3; version 2 remains a compatibility route for historical multi-action callers. Evaluation must grade the shared action and complete intended target set rather than treating the first match as the command's success. See [ADR-0014](../adr/0014-resolve-one-action-across-current-page-targets.md).

| Instruction                                                | Independently expected result                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| “Click all confirmation buttons in the list”               | One click action and every eligible intended button, excluding outside-list duplicates                                    |
| “Click About us and Contact”                               | One click action and two distinct current-page targets                                                                    |
| “Click Save and Contact” when Contact is absent            | Shared click action, found Save target, missing Contact target and accurate partial summary                               |
| “Click About us and click the button above the red button” | Shared click action and independently graded target identities; missing appearance evidence remains a measured limitation |
| “Click About us and hover over Help”                       | Whole command unsupported because it mixes interaction types                                                              |
| “Click Login, then click the button that appears”          | Whole command unsupported because the requested sequence depends on a page change                                         |
| “Hover over Save, then click it”                           | Whole command unsupported; two interactions on one node do not become a multi-target command                              |

Expected target sets are authored independently of model output. Grade omitted, extra, duplicate and wrong targets plus the shared action, target order where explicit, state and request completeness. Include blocked/missing/found combinations and the 16-entry target limit. Exceeding the limit must be explicit rather than silently truncating. Each found target retains one XPath and shared inference cost is counted once. Source single-target examples do not establish plural-target coverage; keep independently labelled plural fixtures separate.

## Separate model comparison from prompt tuning

For model screening, freeze the same instruction, captured candidates, prompt semantics, structured result contract and grading. Pin the actual serving route and record model version, provider, reasoning settings, output bound, context limits, retries and fallbacks. A model that requires a different API wrapper can still compete, but substantive prompt or reasoning-budget differences must be disclosed; this is then a comparison of configurations, not an isolated model effect.

For tuning, inspect development failures and change one concrete factor: remove duplicated context, compress repeated candidate attributes, preserve only necessary ancestor/frame context, or shorten output that deterministic code can derive. Measure candidate recall independently: dropping the intended node before inference is a capture failure, not evidence that the model chose badly. Never truncate around the gold target or select examples from the eventual winner's successes.

Concise prompts and outputs can reduce latency, but establish a working quality baseline first and measure the tradeoff. The platform's [latency guidance](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency) distinguishes full generation latency from time to first token and warns that hard output bounds can truncate answers. For xpathed, streaming an incomplete JSON response is not yet a usable verified XPath. Keep the existing deterministic XPath construction; the model need not generate repeated DOM evidence or explanations that code already knows.

Test prompt/DOM improvements initially on one model. A successful improvement is a property of that combination until tested elsewhere. If the final two systems use different prompts, report that final comparison as complete resolver configurations. There is no need for a full factorial study to select a useful system, but do not claim the study isolated every interaction.

## Uncertainty and holdout discipline

Pair every comparison on the same cases. The [statistical evaluation recommendations](https://www.anthropic.com/research/statistical-approach-to-model-evals) explain that paired differences remove shared item-difficulty variation and make model comparisons more informative. Preserve per-case wins, losses and ties, not just two aggregate percentages. For related examples, compute uncertainty over independent families; treating twenty actions on one page as twenty independent websites overstates evidence.

Small samples can find large problems cheaply, not certify tiny improvements. As an illustrative calculation under independent Bernoulli sampling, 100 trials with zero failures still give an approximately 2.95% one-sided 95% upper failure bound (`1 - 0.05^(1/100)`). Approximately 299 independent zero-failure trials are needed to get that bound below 1%. Real page-family clustering weakens those assumptions. Repeating the same easy cases does not replace broader coverage.

Use predeclared checkpoints for exploratory screening and one final comparison of frozen candidates. Do not repeatedly peek at ordinary 95% intervals and stop the moment one excludes zero while still calling the final result a 95% test. Formal sequential claims need an appropriate sequential method; for this repository, a separate fixed final set is the simpler initial choice. If its result is inspected to tune the system, retire the exposed families into regression and obtain fresh confirmation evidence. [Adaptive holdout research](https://arxiv.org/abs/1506.02629) establishes why repeated adaptive reuse can overfit the holdout itself.

[tinyBenchmarks](https://arxiv.org/abs/2402.14992) demonstrates that curated small sets can estimate some established benchmarks efficiently. It does not establish that 100 arbitrary XPath cases represent our corpus. Its learned/calibrated selection methods require additional response data and validation; start with stratified sampling and explicit uncertainty rather than claiming their published accuracy savings transfer automatically.

## Measure latency and expenditure honestly

Interleave model order across paired cases to reduce time-of-day effects. Use the same browser/capture resources and declared concurrency; separate cold and warm measurements. Record capture, inference, verification and total latency. Low-concurrency request latency and high-concurrency throughput answer different questions. Batch-discount jobs may lower evaluation bills, but their completion times do not measure interactive production latency. [Infrastructure-noise measurements](https://www.anthropic.com/engineering/infrastructure-noise) show why execution resources, time limits and runtime conditions belong in the experiment record.

For each stage, sum measured usage against timestamped route prices:

`estimated USD = sum(input tokens × input rate + billed output tokens × output rate + applicable cache/request charges)`

Use the provider's reported total separately when available; reasoning tokens may be billed even when absent from visible output. Preserve unknown charges instead of reporting them as zero. After the first small block, forecast the remaining stage using measured mean and tail usage. An enforceable spending ceiling also needs declared maximum requests, input/output bounds, current prices and a reservation for each in-flight request; an expected average alone is not a hard cap.

The accepted initial ceiling is $5 total across the experiment, including retries and configuration variants. Use standard serving only; the batch-pricing discussion above is background, not an approved execution path. Freeze the selected routes and sample plan, account for existing ledger charges, and forecast remaining measured usage before another stage. Full-corpus runs should be exceptional final audits of a frozen candidate or targeted investigations, not the inner loop for every prompt edit. Existing broad-corpus dollar scenarios are planning arithmetic, not a requirement to spend those amounts.
