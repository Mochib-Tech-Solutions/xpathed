# Independent resolution evaluation

Evaluation answers whether the resolver selected the intended targets, interpreted the action correctly, and returned verified XPath and state information. Independent labels define the expected answer; a unique XPath alone cannot establish intended-target correctness. Resolution inspects and highlights targets without executing the requested interaction.

The **evaluation set** has three categories: **model selection**, **XPath construction and verification**, and **Resolver E2E**. Model selection uses reviewed saved inputs and live inference. XPath evaluation supplies controlled selections directly to Browser. Resolver E2E evaluates the complete request with a real browser and model. The chat workspace is a test client outside this boundary. A regression is a lost pass between compared runs. Repeated use of these cases does not establish unseen-data generalization. [ADR-0025](adr/0025-evaluate-selection-xpath-and-resolver-separately.md) records these boundaries.

[ADR-0026](adr/0026-use-the-release-branch-as-the-baseline.md) makes the release commit the comparison baseline. CI evaluates the proposed change before merge; merging establishes the next release.

## One evaluation set, grouped by behavior

```text
evaluation/
  cases/          # Shared browser cases grouped by behavior, with one loader
  fixtures/       # Controlled pages and independent target oracles
  datasets/       # Source adapters and the reviewed private collection manifest
  research/       # Resolver comparison and archived research continuation
  accounting/     # Shared charge records
  run.mjs         # Browser trials and replay
  model.mjs       # Live selection from reviewed saved inputs
  xpath.mjs       # Browser XPath verification from controlled selections
  compare.mjs     # Candidate/baseline and monitoring orchestration
  grader.mjs      # Independent grading
  policy.json     # One current release acceptance policy
  configuration.mjs # Evaluation settings supplied by the environment
  provider.mjs    # Shared provider integration
scripts/release/  # Images, evidence, release publication and monitoring
```

Cases are organized by the behavior they check. Shared XPath/Resolver case IDs and browser/pipeline test titles use `<group>-<behavior>`, such as `targeting-save-button-by-name`, `scope-offscreen-target-is-absent` and `state-readonly-notes-fill-is-blocked`. Names describe the condition and expected result; historical case IDs remain in `sourceIds` for provenance. Saved runs retain their original case identities. The shared loader also serves deterministic CI. Injected-provider failures and saved-locator mutation cases remain engineering checks; selection records why they are excluded from live release inference. Unit, integration and UI tests keep their existing locations and ordinary CI ownership.

Each release comparison freezes the complete eligible browser collection and every reviewed eligible imported case. Both candidate and release baseline receive the same case inputs and current grading rules, with one original attempt per arm. Browser state resets independently. New cases and improved checks are welcome: apply the same updated expectations to both arms. Changing the collection or grader after a run requires another comparison.

### Compare configurations on equal cases

Name each arm by its configuration: source/image identity, model, provider, prompt, reasoning and output limit. A source change plus a prompt change is a system comparison; it cannot isolate a model or prompt effect.

Freeze one case collection and grader for both arms. Give each arm the same cases, one original attempt per case, with no automatic retries or replacements after failures. Report planned, completed and failed counts for each track. Missing results stay visible and fail release completeness.

Use the group files listed in `evaluation/cases/index.json` for browser categories: targeting, cardinality, appearance, context, scope, state, robustness and frames. Provider-failure and saved-locator cases remain deterministic checks. Historical `family` values identify related fixtures; they are not the current behavior categories. Offline source labels do not establish these browser capabilities.

Show paired gains and losses, plus passing cases over the full denominator, for every group and arm. Keep browser and offline results separate. Provider routes, cache conditions and execution settings belong beside the scores. An unchanged release configuration rerun measures repeatability, not a new implementation improvement.

A historical configuration may be an explicitly selected research comparator. Release CI compares with the existing release commit under the current policy. The release launcher accepts one candidate and one baseline; comparing several model profiles requires a separate research run with the same frozen inputs.

### Browser cases

A live browser case is a Resolver E2E evaluation: Browser captures candidates, the real model selects targets, Browser constructs and verifies XPath expressions and observes readiness, and the independent oracle grades the final API response. There is no separate paid XPath-algorithm phase.

Grading distinguishes capture coverage, intended-target identity, unique same-node XPath matching, action interpretation, exact plural target sets, scoped absence, readiness and completeness. Missing, extra, duplicate and incorrect targets remain distinct. Privacy, oracle leakage and unintended page changes are hard failures. Deterministic mutation checks separately assess old-locator reuse and fresh resolution after a page change.

### Imported cases

PhraseNode and adapted Mind2Web retain original source IDs, splits, family relationships, checksums, labels, transformation history and review evidence. Import support does not imply that every imported record is approved for live submission. Mind2Web contributes only after an eligible adaptation is independently reviewed; the presently prepared release collection contains reviewed PhraseNode inputs.

Offline cases use the Resolver's offline selection path and shared prompt/schema. Live runs make real model calls against these saved inputs and grade the selected target against its independent label. Historical data cannot establish current viewport membership, live XPath identity, pointer interception, readiness or plural completeness. One report includes both tracks with separate denominators and limitations. Original dataset splits describe provenance; they do not make repeatedly used evaluation cases an untouched holdout.

### XPath construction and verification

`evaluate:xpath` reuses the browser case definitions and independent DOM labels. It captures a real page, materializes the fixture's controlled selected IDs, and calls Browser's `/pages/{pageId}/selections` endpoint directly. It starts Browser and the fixture only. No Resolver or model call occurs. The raw browser response is retained alongside a grader adapter; the adapter is not evidence that the Resolver ran.

The category checks document-wide XPath uniqueness, intended-node identity, frame identity, state/readiness and passive behavior. Saved-locator mutations also check old XPath reuse and fresh construction after a page change. Cases without a found target and provider/Resolver-error cases are excluded with explicit reasons in the manifest. They remain covered by Resolver evaluation and existing engineering checks. Original case IDs and source split metadata stay intact.

## Example cases and metrics

These examples come from the shared case files. The fixture establishes the page state; its independent expected selector is used only by the grader. Live Resolver E2E must discover the target from the instruction. XPath evaluation supplies the selection and tests Browser directly.

| Case and source | Instruction and setup | Required result | Metric exercised |
| --- | --- | --- | --- |
| `targeting-save-button-by-name` — [targeting](../evaluation/cases/targeting.json), `form` fixture | “Click Save changes.” | `click` on `#save-profile`, one matching XPath and ready passive checks | Target identity, action correctness, XPath uniqueness |
| `cardinality-all-approval-buttons-include-disabled-target` — [cardinality](../evaluation/cases/cardinality.json), `batch` fixture | “Click all Approve buttons in Approvals.” | Exactly `#approve-invoice` and `#approve-expense`; the latter remains found with blocked/disabled readiness | Whole-set completeness and per-target readiness |
| `scope-offscreen-target-is-absent` — [scope](../evaluation/cases/scope.json), `offscreen` fixture | “Click Help.”; Help is below the viewport | `not_found`, with no invented target or scrolling | Current-view absence; Resolver E2E only |
| `state-readonly-notes-fill-is-blocked` — [state](../evaluation/cases/state.json), `states` fixture | “Fill Notes.” | `fill` on `#notes`, found and readonly, with blocked readiness and failed writable check | Action/state separation |
| `locators-wrapper-insertion-preserves-current-view-target` — [locators](../evaluation/cases/locators.json), `form` fixture | “Click Save changes in Profile.”; insert a wrapper after resolution | Saved XPath still matches `#save-profile`; fresh construction also identifies it | Locator reuse and reconstruction; deterministic evaluation |

A real model-selection example is `phrasenode-db978249f30c2c27d84a36a8` in the [reviewed PhraseNode collection](../evaluation/datasets/collection.json): “click on site news”, with independently labelled target `n19`. The model receives the original instruction and saved candidates; the expected ID is retained separately for grading. A pass requires the selected set to contain exactly that labelled target. Selecting the label plus an extra candidate fails. This checks selection only; there is no live page on which to establish XPath or readiness. The complete candidate payload stays in the private reviewed archive. This excerpt describes the expected result, not a new measured run.

### Reading the measurements

| Measurement | Calculation / boundary | What a pass establishes |
| --- | --- | --- |
| Model selection accuracy | Correct exact target sets / all planned eligible saved-input cases | Agreement with the imported independent target label |
| XPath category pass rate | Cases passing all applicable Browser/oracle checks / selected XPath cases | Locator identity, frame/state checks and applicable mutations with controlled selections |
| Resolver E2E pass rate | Cases passing all required final-response checks / all selected E2E cases | Correct action, target set or absence, XPath, readiness and response contract together |
| Common comparison score | Correct action and full target set, with applicable safety checks / all shared comparison cases | Comparable action/target behavior across Basic, Improved and Stagehand |
| Target-selection comparison score | Correct exact node sets or absence / shared cases with supported target expectations | Selection independently of action naming; operational and safety failures still fail |
| Gains and regressions | Paired fail→pass and pass→fail on the same case | Which behaviors changed; a net gain can still contain regressions |
| Latency | Median and p95 from the recorded request interval, separated by execution cohort | Observed timing under those conditions; failed attempts remain recorded |
| Cost | Sum of reported charges, alongside estimates and counts of unreported charges | Known spend; an unavailable charge is never zero |

All planned failures remain in their category denominator. Category-specific exclusions are recorded before execution. The three-system comparison's common score is narrower than full Resolver E2E: Stagehand does not produce the xpathed readiness/coverage contract. See [case outcomes](research/engineering-comparison.md#case-examples) for examples of a shared pass, a gain and regressions.

## Run and replay

From the repository root:

```sh
pnpm evaluate -- --output .artifacts/evaluation/my-complete-run
pnpm evaluate:model:live -- --case PHRASENODE_CASE_ID --output .artifacts/evaluation/my-model-check
pnpm evaluate:xpath -- --case targeting-save-button-by-name --output .artifacts/evaluation/my-xpath-check
pnpm evaluate:resolver:live -- --case targeting-save-button-by-name --output .artifacts/evaluation/my-e2e-check
pnpm evaluate:resolver -- --case targeting-save-button-by-name --output .artifacts/evaluation/my-controlled-check
pnpm evaluate:replay RUN_DIRECTORY
```

`pnpm evaluate` runs all three categories serially, including paid model calls. It preflights the reviewed collection and dedicated key, keeps each category's artifacts under `model/`, `xpath/` and `resolver/`, and writes a root summary with separate denominators and costs. Ordinary failed cases remain visible while later categories run; interruption or an integrity failure stops continuation. Missing category evidence cannot pass. This command does not approve a release. Use `pnpm evaluate -- --help` for its scope.

Individual category commands accept `--case` and `--output`. `evaluate:model:live` uses the digest-verified reviewed collection, one original attempt per case, the Resolver's existing offline worker, and the provider accounting/identity checks. It needs only Resolver and the evaluation runner. Missing reviewed inputs fail before Docker starts; obtain them with `pnpm datasets:collection fetch`. Provider failures retain their evidence; provider identity/cache or worker-integrity failures stop further attempts.

`evaluate:resolver` is the provider-free complete-pipeline check used in CI; `evaluate:resolver:live` uses the real model. Controlled browser cases run concurrently in fresh sessions, with up to four workers based on available CPUs. Use `--concurrency 1` for serial timing. Live categories remain serial. The manifest records concurrency; parallel timings include contention. The old `evaluate:live` name is replaced by `evaluate:resolver:live`, and the old deterministic `evaluate` command is now `evaluate:resolver`.

A controlled provider response makes fixtures, contracts and grader checks repeatable; those results are not model-quality scores. Live mode calls the configured route. Use `OPENROUTER_EVAL_API_KEY` in the environment or ignored evaluation environment file. Keep the application's key separate; deterministic CI receives no provider credentials.

The wrapper starts only the services needed by its category in an isolated Compose project, then stops its containers. It does not require Web or ClientApi. `XPATHED_EVALUATION_PROJECT` selects a distinct `xpathed-evaluation-...` project for concurrent work. Output directories must be new and writable through Docker's mount; a VM-backed engine requires a shared host path. Preserve every original attempt in its own run directory, including interrupted and failed attempts.

Run the complete paired release comparison through `pnpm release:evaluate`; see [release workflow](releases.md). This launcher verifies the saved images and starts the offline Resolver worker. The underlying `pnpm evaluate:qualify` runner cannot start a complete collection by itself; filtered browser-only deterministic checks remain available. `pnpm evaluate:qualify:replay RUN_DIRECTORY` regrades saved comparison evidence without services or paid calls. A filtered check cannot replace the complete release comparison.

Replay reads the saved manifest, observations and original trials with their matching grader. It makes no provider calls and does not recreate the historical browser. Use the recorded source revision for older artifacts rather than applying today's policy to old release claims.

## Release acceptance

The single current policy is `evaluation/policy.json`:

- Every case the release baseline passes must also pass for the candidate. Gains elsewhere cannot offset a lost pass.
- Safety violations, operational failures, invalid contracts, missing required results and artifact mismatches fail the comparison.
- Existing semantic failures remain visible. Equality can pass when there are no lost passes and the required invariants hold.
- Median/p95 latency and reported/estimated/unknown costs are descriptive. Slow results and missing billing metadata are not release blockers.

There is one complete comparison, with no required pilot or fresh held-out phase. The collection grows as regressions and useful new cases are reviewed. Retain independent labels and all outcomes; do not retry away failures or claim generalization from repeatedly inspected cases.

Resolver E2E timing is the Resolver HTTP duration, including capture, inference and live verification. Fixture setup and independent grading are outside the timer. Test-client rendering is outside this system boundary. One-attempt results are observations of this run, not statistical guarantees.

## Private dataset collection

`evaluation/datasets/collection.json` pins the private archive's repository, release asset, local path, digest and inventory. The payload lives under ignored `.artifacts/datasets/`; raw or derived page inputs are not committed to source.

Build a reviewed collection from imported inputs and explicit review files:

```sh
pnpm datasets:collection pack IMPORT_DIRECTORY .artifacts/datasets/reviewed.json.gz REVIEW_FILE...
```

Packing checks source/input identity, eligibility, submission review and duplicate case IDs. Record its emitted digest and inventory in the collection manifest. Publication is a separate authorized operation; packaging a file does not upload it.

Obtain and verify the pinned private asset with:

```sh
pnpm datasets:collection fetch
```

The private `evaluation-data/reviewed-72d140c1.json.gz` asset is published. A fresh download was checked against the pinned digest; the workflow performs the same verification before reading the collection. A missing or changed required dataset fails completeness checks; it must not silently reduce the release denominator.

Use `pnpm datasets:fetch` and `pnpm datasets:import` with the checked-in source manifests to prepare collection inputs. Reviewed offline cases run through the release evaluator. Keep imported, excluded, unsupported, ambiguous and unreconstructible records visible with reasons. Dataset terms and submission review remain required even when cost is unrestricted.

## Cost and provider evidence

Track estimates, token usage, provider generation IDs, reported charges and unknown amounts separately. Cost amounts, estimate overruns, missing prices, unavailable billing metadata and accounting-service availability do not stop resolution evaluation or reject a release. Preserve charge records where available and report accounting failures explicitly; never invent a zero charge.

Authentication, transport failures, provider rejection and missing resolution results are operational failures. A completed transport failure remains a failed attempt with its original charge status; once the proxy is idle, the runner continues with the next distinct attempt. It does not retry. Identity, response-cache and evidence-integrity violations still stop the run. A provider-enforced key limit can reject a call, but the evaluator adds no monetary continuation gate. Keep the dedicated evaluation key, standard routes, original attempts and existing charge history. Successful billing reconciliation never turns a failed model response into a passing case.

## Research comparisons

`main` contains the selected resolver, release evaluation and the resolver comparison below. Retired model, dataset and context experiment runners are available at their recorded Git revisions. New alternatives belong on branches; accepted changes replace the selected implementation and prompt. See [ADR-0024](adr/0024-keep-one-resolution-implementation.md).

### Resolver comparison

Use **Basic resolver**, **Improved resolver** and **Stagehand** in reports and charts. Git commits and image identities belong in saved evidence. For a new comparison, Basic must be a verified bundle implementing the same current API contract; Improved is built from the current checkout, with its source fingerprint and exact image IDs recorded. To reproduce the published historical Basic comparison, check out the recorded runner revision from its evidence first: the current runner does not adapt retired numbered contracts or bundle formats. The application keeps one implementation.

```sh
pnpm evaluate:compare -- \
  --basic-bundle BASIC_BUNDLE_DIRECTORY --basic-sha256 MANIFEST_SHA256 \
  --case targeting-save-button-by-name --output .artifacts/resolver-comparison-check

# Explicit paid comparison of every eligible shared browser case.
pnpm evaluate:compare -- --mode live \
  --basic-bundle BASIC_BUNDLE_DIRECTORY --basic-sha256 MANIFEST_SHA256 \
  --output .artifacts/resolver-comparison-live

pnpm evaluate:compare:replay .artifacts/resolver-comparison-live
# Refresh the recorded report after setting its run identity and narrative.
uv run docs/assets/evaluation/engineering-plot.py .artifacts/resolver-comparison-live
```

The launcher verifies and restores the archived bundle, builds the current resolver and pinned Stagehand adapter, and starts an isolated evaluation stack. `--resume` with the original output directory continues only unattempted arms using the original image IDs; it rejects changed cases, evaluation code, plan, timeout settings or runtime images and unrecorded provider attempts. Replay verifies both graders and recomputes the shared and full resolver scores from original observations. Provider identity or response-cache violations retain the affected attempt and stop further calls. A fresh run gives its images unique local retention tags recorded in `image-tags.json`; keep those tags available for continuation. Set `XPATHED_EVALUATION_PROJECT=xpathed-evaluation-UNIQUE_NAME` for concurrent checkouts. A live run uses `OPENROUTER_EVAL_API_KEY`; scripted singleton and plural compatibility checks must pass before any paid calls.

All arms use the same case inputs and independent node labels. Browser binary, viewport, document checksum, initial state, language and time zone must match. Stagehand uses stock `observe` with a current-view instruction, one model call, no response reuse and no self-healing. The first singleton suggestion or complete plural set is graded; later suggestions cannot rescue an incorrect singleton. Explicit plural labels live with the shared cases.

The common score measures action and target-set correctness, passive behavior and privacy. Correct absence can pass without an action when Stagehand returns no suggestions; partially absent requests compare the found set. Full resolver-contract scores separately include readiness, capture coverage and outcome details. Adapter selector errors are failures, including on unsupported-instruction cases. Unsupported capabilities and provider errors stay in the denominator.

One worker runs each arm, so three isolated streams run concurrently. Each stream processes its frozen case order serially. Stagehand waits for the matching Basic browser observation before checking parity. There are no retries. Provider caching and host contention can affect latency; serial and parallel timing cohorts are reported separately. Retain every original request, response, charge and unknown charge locally. The export contains aggregate metrics, per-case outcomes and evidence hashes; it excludes page/provider payloads. Category charts use the shared behavior groups. Live browser results remain separate from imported offline selection and release publication.

### Continue a research comparison in parallel

`evaluation/research/parallel-comparison.mjs` continues a frozen paired research run with up to eight provider workers. One worker owns browser cases; the others run offline Resolver processes. Each worker has its own proxy state and charge ledger. A routing token selects the worker while the Resolver endpoint and configuration identity stay unchanged.

The operator first drains the original run, preserves its directory, and starts an isolated stack from the same verified candidate and baseline images. The continuation requires those artifact identities, an explicit `XPATHED_RESEARCH_CONTINUATION=true`, and a host offline worker with the matching concurrency. Inside that prepared stack:

```sh
node evaluation/research/parallel-comparison.mjs \
  --source ORIGINAL_RUN --output NEW_RUN --concurrency 8
```

The runner copies the frozen plan and evidence, retains completed successes and failures, and executes only missing arms. An unfinished attempted arm blocks continuation; it is never silently retried. Identity, response-reuse or evidence-integrity failures stop new work while active attempts drain.

Keep the phase manifest, per-arm claims, worker charge ledgers and before/after image receipts. Report serial and parallel latency cohorts separately because contention and cache conditions differ. This path produces research evidence; ordinary release comparison and publication remain unchanged.

Dated reports in `docs/research/` preserve their original scores, policies, limits and commands. See the [external dataset pilot](research/external-dataset-pilot-report.md), [labelled baseline](research/deepinfra-labelled-baseline-report.md), [Stagehand evidence](research/stagehand-v4-compatibility.md), [current-view comparison](research/viewport-baseline-report.md) and [context experiment](research/jev-context-comparison-report.md). Replay historical experiments from their recorded revision.

## Evidence and monitoring

A run saves its manifest, frozen cases and configuration, every original trial, summaries, and available provider evidence. Keep these artifacts private because sanitized page text can still be sensitive. Preserve source/image identity and Git release history separately from expiring page/provider evidence. Run pruning does not erase the charge history or extend original retention deadlines.

Nightly monitoring repeats the complete collection published with the current release commit, using its saved images and measurements. It records drift and operational failures without deploying or selecting a configuration. See [monitoring](releases.md#nightly-monitoring).
