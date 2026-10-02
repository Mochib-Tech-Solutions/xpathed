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

### Compare Basic, Improved and Stagehand

The recorded Basic resolver and Improved resolver comparison uses the same DeepSeek V4.1 Flash model, Wafer provider and inference settings. The browser implementation makes three rules explicit:

- Match the requested control itself; headings, scope containers and repeated descendant text provide context.
- Report missing targets within the current view. Completeness describes whether every requested target is represented, including absent targets.
- Recheck viewport membership after inference before returning found or absent results.

The [current comparison](research/engineering-comparison.md) evaluates the archived Basic resolver, the current Improved resolver and Stagehand on the same 183 browser cases. The common action-and-target score is **161/183**, **169/183** and **103/183**, respectively. Improved gains 15 passes and loses 7: scope and targeting improve most, while state cases lose one net pass. These are combined system changes, so the run cannot attribute the gain to one prompt rule.

Action interpretation matters separately from selecting the right element. Without requiring the action name, exact target selection on the 175 supported-instruction cases is **160/175**, **169/175** and **136/175**. Stagehand's stock `observe` does not return the full readiness or absence contract; the report keeps these capabilities separate. All failures remain visible.

The seven regressions include three malformed model responses, two changed action interpretations, one incorrect unsupported result and one wrong target for an absent request. The aggregate improvement does not satisfy the release gate's no-regression requirement. One attempt per case also leaves model variation unresolved.

Three isolated workers run concurrently, one per system. Original evidence, charges, source identities, image identities and timing cohorts are preserved. The application carries one selected implementation; archived images and Git preserve Basic. Exact prompt versions remain reproducibility details rather than visible comparison labels.

## Keep one implementation

The controller accepts and validates HTTP requests. `ResolutionService` coordinates capture, selection and verification; `CandidateInput` prepares model evidence; `ActionSelectionStrategy` owns the single prompt, schema and selection validation; `BrowserEvidence` validates browser responses. `OpenRouterGateway` owns provider transport and accounting. Browser and offline selection share the prompt and schema. Operational credentials, model/provider, endpoint and timeout remain deployment settings.

Update the selected implementation in place. Retired contracts and experiment selectors are removed. Git history and saved release images preserve the earlier behavior.

## Why each test exists

| Test                         | What it establishes                                                                           | Why it is separate                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| .NET unit and API tests      | Parsing, validation, cancellation, accounting and HTTP contracts with controlled dependencies | Fast feedback on code rules without browsers or paid providers               |
| Web component tests          | Tabs, chat state, result rendering and client interactions                                    | Checks UI behavior in a simulated DOM                                        |
| PostgreSQL integration tests | Real schema, migrations, persistence, isolation and retention                                 | Database behavior needs the actual database                                  |
| Resolution browser tests     | Real Chromium capture, XPath identity, frames, stale pages, readiness and passive state       | A mock DOM cannot establish browser behavior                                 |
| Deterministic evaluation     | Shared cases through capture, scripted model output and independent grading                   | Detects pipeline regressions without model variation or cost                 |
| Live engineering comparison  | Basic, Improved and Stagehand accuracy, category gains/losses, latency and cost               | Measures actual model decisions under matched conditions                     |
| Offline dataset evaluation   | Selection against imported labelled candidates                                                | Adds data variety but cannot prove browser readiness or viewport correctness |
| Replay                       | Regrading saved evidence without another inference call                                       | Checks grading and reporting while preserving original attempts              |
| Release evaluation           | Candidate versus approved images under the complete current policy                            | Protects existing passes before a release is approved                        |

Tooling tests check the runners, graders, accounting and release scripts themselves. Formatting, analyzers, builds and Docker configuration checks catch source or packaging problems; they do not measure model accuracy.

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
