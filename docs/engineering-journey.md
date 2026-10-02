# Engineering decisions

xpathed resolves one English action across targets in the current view. Its design keeps language interpretation measurable, locator verification deterministic and failures available for investigation.

## Give the model a bounded job

The model selects candidate IDs from browser observations. Browser code builds XPath and verifies that it uniquely identifies the selected node. This division prevents invented locator text from becoming the trust boundary.

The remaining uncertainty is explicit: the model may select the wrong element. Independent expected targets measure that error. A disabled intended target can be correctly selected while remaining unavailable for the requested action.

The runtime uses one selection call. DeepSeek V4.1 Flash through OpenRouter's Wafer provider is an inexpensive default for live testing, with reasoning and provider fallback disabled and strict structured output. Its target accuracy, latency and cost must be measured on the project's cases. No model is trained here.

Model, provider, prompt and schema settings form a configuration identity. Evaluate changes together on the same cases before approving them.

## Match the scope to the visible page

The current-view boundary makes “all” inspectable. A plural instruction must return the complete intended set inside that view, including disabled or covered targets. Off-screen controls require manual scrolling and another request.

Capture supplies names, role, structural context, state, geometry and supported CSS colors. It keeps the complete scoped inventory and fails explicitly when resource limits prevent a complete capture. This avoids interpreting a missing candidate as proof that the target does not exist.

## Verify identity, then report readiness

An XPath match must be unique in its whole document and refer to the captured node. Frame identity stays separate because XPath cannot cross documents. Current-view membership is checked again after inference so page changes cannot silently validate stale evidence.

Readiness is a passive observation. A valid locator does not establish event behavior or a successful business action. Execution and postconditions belong to a future runner integration.

Semantic anchors and explicit test attributes are preferred over ordinary IDs and structural paths. Mutation tests check both saved-locator reuse and fresh resolution after page changes; neither promises survival through every redesign.

## Measure each failure at the right boundary

Controlled browser cases define expected nodes independently of model input. They grade capture coverage, exact target sets, action, XPath identity, readiness, privacy and passive state. Deterministic provider responses check pipeline behavior; live runs measure model selections.

Reviewed imported data adds language and page variety. Offline target selection cannot establish live readiness or viewport correctness, so its denominator stays separate. Repeatedly used cases are regression evidence, not unseen-site generalization.

### Compare the changed configurations

The earlier and current configurations use the same DeepSeek V4.1 Flash model, Wafer provider and inference settings. The browser prompt changes from 8 to 10; offline selection keeps prompt 7 unchanged. The current browser configuration makes three rules explicit:

- Match the requested control itself; headings, scope containers and repeated descendant text provide context.
- Report missing targets within the current view. Completeness describes whether every requested target is represented, including absent targets.
- Recheck viewport membership after inference before returning found or absent results.

The complete comparison used identical inputs and grading rules for both saved configurations. Browser passes increased **111→120/140**, with **10 gains and one regression**. Offline selection was **716→710/1,084**, with **78 gains and 84 losses** despite an unchanged prompt and configuration. This measures combined browser changes and repeated offline calls; it does not isolate individual prompt rules.

The browser regression correctly reported an absent option but changed the explicit action from `click` to `select`. Action interpretation and target correctness need separate checks. The run does not meet the release gate. The [comparison report](research/configuration-comparison.md) retains every failure, separates serial and parallel latency, and reports known and unavailable charges.

## Preserve evidence and protect known behavior

ClientApi stores attempts, outcomes, configuration, timings and sanitized evidence in PostgreSQL. Storage problems do not replace semantic results. Investigation starts from the attempt and trace IDs, then separates capture, provider, contract, stale-page and target-selection failures. An operational log alone cannot establish the user's intended target.

Ordinary CI remains provider-free. Release evaluation compares exact candidate and approved images on the same complete collection, with one original attempt per case and no automatic retries. Approval requires no lost baseline pass and valid contract, safety and artifact checks. Latency and cost remain descriptive; missing charges remain unknown.

Activation is explicit. Nightly monitoring repeats approved cases and reports drift without changing the running application. Replay regrades retained evidence; it cannot recreate an arbitrary historical website.

## What to improve next

1. **Target known errors:** naming, relational context, action interpretation and complete target sets. Add reviewed cases and require comparisons that preserve existing passes.
2. **Measure authoring value:** integrate with a test-authoring workflow and measure accepted suggestions, corrections and time to a correct locator.
3. **Extend with separate evidence:** evaluate locator-repair suggestions, failure triage and test drafting while preserving intended targets and assertions.

Business savings and hosted capacity remain unmeasured. The useful advantage would be reviewed evidence about real instructions and page changes, coupled with a release process that protects known behavior.

The [evaluation guide](evaluation.md) and [release runbook](releases.md) contain the operational procedures.
