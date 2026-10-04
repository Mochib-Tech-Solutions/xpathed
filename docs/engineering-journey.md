# Engineering decisions

xpathed resolves one English action across targets in the current view. Its design keeps language interpretation measurable, locator verification deterministic and failures available for investigation.

Resolver is the core API. Browser supplies capture and verification through a replaceable HTTP service contract; Playwright/Chromium is the verified implementation. The chat workspace is a manual test client. [Browser integration](runtime.md#browser-integration) describes the replacement contract and current limits.

## From Basic to Improved

The progression below explains what changed and why. **Basic** is the archived earlier current-view setup used in the comparison; it already selected candidate IDs and verified XPath in the browser.

| Step                           | Change                                                                                                        | Reason                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Basic                          | Capture the current view, ask the model to select targets, then verify their XPath and state                  | Establish a working baseline with measurable target correctness                                           |
| Clarify selection              | Distinguish requested controls from section containers and repeated descendant text                           | Reduce selections of surrounding context instead of the intended control                                  |
| Clarify absence                | Give missing candidates and empty captures explicit outcomes; completeness covers every requested target      | Avoid confusing a missing target with an incomplete answer                                                |
| Revalidate the view            | Check current-view membership again after inference                                                           | Reject results based on targets that moved out of scope while the model was responding                    |
| Consolidate the implementation | Share one prompt and schema between browser resolution and Saved-page selection; remove retired runtime paths | Keep future changes in one place, with earlier implementations recoverable through Git and image archives |
| Compare the result             | Run Basic, Improved and Stagehand against the same independently labelled browser cases                       | Measure the combined effect, expose regressions and separate action interpretation from target selection  |

We measured Basic and Improved as complete systems. There is no isolated accuracy measurement for each intermediate step. The [recorded 3 October comparison](research/clean-evaluation-comparison.md) contains category results, paired gains and losses, costs and original evidence identities for its pinned configurations. It predates the spatial-item change below.

### Preserve whole-item spatial identity

A request for the item below Backpack on Sauce Demo could select Backpack's Add to cart button or Bike Light beside it. Geometry existed, but product wrappers were missing and controls lacked item grouping. Browser now retains generic repeated whole-item containers and parent identities; Resolver supplies a named layout of nearest aligned neighbors and distinguishes cards from their images and controls. All original candidates remain available. Relationships follow measured geometry, including reordered CSS grids, and are revalidated before returning a result.

The [spatial investigation](research/spatial-item-selection.md) records the exact requests, five passing real-page checks and a separate complete paired pipeline run: pre-fix main 160/191, final candidate 169/191, nine gains and zero lost passes. It also retains the initial variant's lost absence pass and the final 22 shared failures. That supplementary run compares two Improved revisions; the [current three-system refresh](research/clean-evaluation-comparison.md) separately remeasures Basic, Stagehand and saved-page selection.

## Give the model a bounded job

The model selects candidate IDs from browser observations. Browser code builds XPath and verifies that it uniquely identifies the selected node. This division prevents invented locator text from becoming the trust boundary.

The remaining uncertainty is explicit: the model may select the wrong element. Independent expected targets measure that error. A disabled intended target can be correctly selected while remaining unavailable for the requested action.

The runtime uses one selection call. DeepSeek V4.1 Flash through OpenRouter's Wafer provider is an inexpensive default for tests with live provider inference, with reasoning and provider fallback disabled and strict structured output. Its target accuracy, latency and cost must be measured on the project's cases. No model is trained here.

Model, provider, prompt and schema settings form a configuration identity. Evaluate changes together on the same cases before approving them.

## Match the scope to the visible page

The current-view boundary makes “all” inspectable. A plural instruction must return the complete intended set inside that view, including disabled or covered targets. Off-screen controls require manual scrolling and another request.

Capture supplies names, role, structural context, state, geometry and supported CSS colors. It keeps the complete scoped inventory and fails explicitly when resource limits prevent a complete capture. This avoids interpreting a missing candidate as proof that the target does not exist.

## Verify identity, then report readiness

An XPath match must be unique in its whole document and refer to the captured node. Frame identity stays separate because XPath cannot cross documents. Current-view membership is checked again after inference so page changes cannot silently validate stale evidence.

Readiness is a passive observation. A valid locator does not establish event behavior or a successful business action. Execution and postconditions belong to a future runner integration.

Semantic anchors and explicit test attributes are preferred over ordinary IDs and structural paths. Mutation tests check both saved-locator reuse and fresh resolution after page changes; neither promises survival through every redesign.

## Measure each failure at the right boundary

Controlled browser cases define expected nodes independently of model input. They grade capture coverage, exact target sets, action, XPath identity, readiness, privacy and passive state. Deterministic provider responses check pipeline behavior; runs with live provider inference measure model selections. Both use real Chromium when evaluating Live-browser Resolver.

The evaluation set separately measures Saved-page selection, XPath construction and verification, and Live-browser Resolver. The XPath category supplies controlled selections directly to Browser and checks the resulting locators against independent DOM labels. Reviewed imported data adds language and page variety. Saved-page selection cannot establish browser readiness or viewport correctness, so its denominator stays separate. Repeatedly used cases measure this set; they do not establish unseen-site generalization. Comparisons report regressions as lost passes.

### Compare Basic, Improved and Stagehand

The refreshed Basic resolver and Improved resolver comparison uses the same DeepSeek V4.1 Flash model, Wafer provider and inference settings. The browser implementation makes three rules explicit:

- Match the requested control itself; headings, scope containers and repeated descendant text provide context.
- Report missing targets within the current view. Completeness describes whether every requested target is represented, including absent targets.
- Recheck viewport membership after inference before returning found or absent results.

The [recorded comparison](research/clean-evaluation-comparison.md) measures Basic and Improved on the same admitted saved-page inputs, and all three systems on the same final browser cases. Its tables and charts are generated from complete original attempts, with separate denominators for saved-page selection, browser action-and-target correctness, target selection alone and the full resolver contract.

The systems prepare their own DOM evidence and prompts; equal page state and independent labels make this a complete-system comparison. The current comparison includes spatial card context and open-shadow coverage, with all three arms remeasured on the expanded collection. The [matched-input rules](evaluation.md#matched-inputs-and-scoring) keep those boundaries explicit.

Action interpretation matters separately from selecting the right element. Stagehand's stock `observe` does not return xpathed's full readiness or absence contract and requires a live page, so it has no saved-page score. The complete fresh saved-page run has no provider-limit refusals; it records both gains and lost passes, and Improved scores lower than Basic in this category despite its higher browser score. Earlier interrupted outcomes remain separate evidence. The [model comparison](research/model-comparison-2026-10-04.md) includes complete compatible Gemini measurements with its required low-reasoning setting, alongside DeepSeek and Luna with reasoning disabled. Failures, gains and regressions remain visible. Aggregate improvement does not override the release gate's no-regression requirement, and one attempt per case leaves model variation unresolved.

Isolated workers run concurrently. Original evidence, charges, source identities, image identities and timing cohorts are preserved. The application carries one selected implementation; archived images and Git preserve Basic. Git commits and saved prompt bytes preserve reproducibility.

## Keep one implementation

The controller accepts and validates HTTP requests. `ResolutionService` coordinates capture, selection and verification; `CandidateInput` prepares model evidence; `ActionSelectionStrategy` owns the single prompt, schema and selection validation; `BrowserEvidence` validates browser responses. `OpenRouterGateway` owns provider transport and accounting. Browser resolution and Saved-page selection share the prompt and schema. Operational credentials, model/provider, endpoint and timeout remain deployment settings.

Update the selected implementation in place. Retired contracts and experiment selectors are removed. Git history and saved release images preserve the earlier behavior.

## Why each test exists

| Test                                                       | What it establishes                                                                           | Why it is separate                                                           |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| .NET unit and API tests                                    | Parsing, validation, cancellation, accounting and HTTP contracts with controlled dependencies | Fast feedback on code rules without browsers or paid providers               |
| Web component tests                                        | Tabs, chat state, result rendering and client interactions                                    | Checks UI behavior in a simulated DOM                                        |
| Resolution browser tests                                   | Real Chromium capture, XPath identity, frames, stale pages, readiness and passive state       | A mock DOM cannot establish browser behavior                                 |
| Live-browser Resolver with deterministic provider fixtures | Shared cases through capture, scripted model output and independent grading                   | Detects pipeline regressions without model variation or cost                 |
| Live-browser Resolver with live provider inference         | Complete resolution API requests with real model selection and browser verification           | Measures action, targets, XPath and readiness on the browser evaluation set  |
| Resolver comparison with live provider inference           | Basic, Improved and Stagehand accuracy, category gains/losses, latency and cost               | Measures actual model decisions under matched conditions                     |
| Saved-page selection                                       | Selection against imported labelled candidates                                                | Adds data variety but cannot prove browser readiness or viewport correctness |
| Replay                                                     | Regrading saved evidence without another inference call                                       | Checks grading and reporting while preserving original attempts              |
| Release evaluation                                         | Candidate versus published images under the complete current policy                           | Protects existing passes before merging a release                            |

Tooling tests check the runners, graders, accounting and release scripts themselves. Formatting, analyzers, builds and Docker configuration checks catch source or packaging problems; they do not measure model accuracy.

## Preserve evidence and protect known behavior

Resolution responses carry attempt and trace IDs, configuration, timings and reason codes. Evaluation runners save their own evidence for investigation and replay. Operational logs separate capture, provider, contract, stale-page and target-selection failures; they cannot establish the user’s intended target.

Ordinary CI remains provider-free. Release publication is deferred; the retained release evaluation procedure compares exact candidate and published images on the same complete collection, with one original attempt per case and no automatic retries. Approval requires no lost baseline pass and valid contract, safety and artifact checks. Latency and cost remain descriptive; missing charges remain unknown.

Activation is explicit. The retained nightly workflow requires published images and measurements before it can report release drift; it never changes the running application. Replay regrades retained evidence; it cannot recreate an arbitrary historical website.

## What to improve next

1. **Target known errors:** naming, relational context, action interpretation and complete target sets. Add reviewed cases and require comparisons that preserve existing passes.
2. **Measure authoring value:** integrate with a test-authoring workflow and measure accepted suggestions, corrections and time to a correct locator.
3. **Extend with separate evidence:** evaluate locator-repair suggestions, failure triage and test drafting while preserving intended targets and assertions.

Business savings and hosted capacity remain unmeasured. The useful advantage would be reviewed evidence about real instructions and page changes, coupled with a release process that protects known behavior.

The [evaluation guide](evaluation.md) and [release runbook](releases.md) contain the operational procedures.
