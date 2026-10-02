# Independent resolution evaluation

Evaluation answers whether the resolver selected the intended targets, interpreted the action correctly, and returned verified XPath and state information. Independent labels define the expected answer; a unique XPath alone cannot establish intended-target correctness. Resolution inspects and highlights targets without executing the requested interaction.

[ADR-0023](adr/0023-simplify-release-evaluation.md) defines the accepted simplification. This runbook describes the new source layout and workflow contract; it does not establish that hosted workflows, private dataset publication, or live qualification have been exercised. The existing approved release keeps its original evidence until replaced.

## One collection, grouped by behavior

```text
evaluation/
  cases/          # Shared browser cases grouped by behavior, with one loader
  fixtures/       # Controlled pages and independent target oracles
  datasets/       # Source adapters and the reviewed private collection manifest
  research/       # Engineering comparison and archived research continuation
  accounting/     # Shared charge records
  run.mjs         # Browser trials and replay
  compare.mjs     # Candidate/baseline and monitoring orchestration
  grader.mjs      # Independent grading
  policy.json     # One current release acceptance policy
  profiles.json   # Selected model/provider configuration
  provider.mjs    # Shared provider integration
scripts/release/  # Images, evidence, approval, activation and rollback
```

Cases are organized by the behavior they check, rather than by the version that introduced them. The shared loader also serves deterministic CI. Injected-provider failures and saved-locator mutation cases remain engineering checks; selection records why they are excluded from live release inference. Unit, integration and UI tests keep their existing locations and ordinary CI ownership.

Each release comparison freezes the complete eligible browser collection and every reviewed eligible imported case. Both candidate and approved baseline receive the same case inputs and current grading rules, with one original attempt per arm. Browser state resets independently. New cases and improved checks are welcome: apply the same updated expectations to both arms. Changing the collection or grader after a run requires another comparison.

### Compare configurations on equal cases

Name each arm by its configuration: source/image identity, model, provider, prompt, reasoning and output limit. A source change plus a prompt change is a system comparison; it cannot isolate a model or prompt effect.

Freeze one case collection and grader for both arms. Give each arm the same cases, one original attempt per case, with no automatic retries or replacements after failures. Report planned, completed and failed counts for each track. Missing results stay visible and fail release completeness.

Use the group files listed in `evaluation/cases/index.json` for browser categories: targeting, cardinality, appearance, context, scope, state, robustness and frames. Provider-failure and saved-locator cases remain deterministic checks. Historical `family` values identify related fixtures; they are not the current behavior categories. Offline source labels do not establish these browser capabilities.

Show paired gains and losses, plus passing cases over the full denominator, for every group and arm. Keep browser and offline results separate. Provider routes, cache conditions and execution settings belong beside the scores. An unchanged approved configuration rerun measures repeatability, not a new implementation improvement.

A historical configuration may be an explicitly selected research comparator. Release approval still compares with the latest approved release under the current policy. The release launcher accepts one candidate and one baseline; comparing several model profiles requires a separate research run with the same frozen inputs.

### Browser cases

A live case exercises the complete Resolver request: Browser captures candidates, the real model selects targets, Browser constructs and verifies XPath expressions and observes readiness, and the independent oracle grades the final response. There is no separate paid XPath-algorithm phase.

Grading distinguishes capture coverage, intended-target identity, unique same-node XPath matching, action interpretation, exact plural target sets, scoped absence, readiness and completeness. Missing, extra, duplicate and incorrect targets remain distinct. Privacy, oracle leakage and unintended page changes are hard failures. Deterministic mutation checks separately assess old-locator reuse and fresh resolution after a page change.

### Imported cases

PhraseNode and adapted Mind2Web retain original source IDs, splits, family relationships, checksums, labels, transformation history and review evidence. Import support does not imply that every imported record is approved for live submission. Mind2Web contributes only after an eligible adaptation is independently reviewed; the presently prepared release collection contains reviewed PhraseNode inputs.

Offline cases use the Resolver's offline selection path. They can establish target-selection correctness, but historical data cannot establish current viewport membership, live XPath identity, pointer interception, readiness or plural completeness. One report includes both tracks with separate denominators and limitations. Original dataset splits describe provenance; repeated release runs are regression evidence, not unseen-data generalization.

## Run and replay

From the repository root:

```sh
pnpm evaluate
pnpm evaluate -- --case CASE_ID --output .artifacts/evaluation/my-check
pnpm evaluate:live -- --case CASE_ID --output .artifacts/evaluation/my-live-check
pnpm evaluate:replay RUN_DIRECTORY
```

Deterministic mode is the default. Individual cases run concurrently in fresh browser sessions, with up to four workers based on available CPUs. Use `--concurrency 1` for serial timing or a value from 1 to 4 to limit resource use. Ordinary live checks and release comparisons remain serial. Research continuation has its own bounded parallel runner below. The manifest records concurrency; parallel-run timings include contention.

A controlled provider response makes fixtures, contracts and grader checks repeatable; those results are not model-quality scores. Live mode calls the configured route. Use `OPENROUTER_EVAL_API_KEY` in the environment or ignored evaluation environment file. Keep the application's key separate; deterministic CI receives no provider credentials.

The wrapper runs Browser, Resolver and the controlled fixture in an isolated Compose project, then stops its containers. It does not require Web, ClientApi or PostgreSQL. `XPATHED_EVALUATION_PROJECT` selects a distinct `xpathed-evaluation-...` project for concurrent work. Output directories must be new and writable through Docker's mount; a VM-backed engine requires a shared host path. Preserve every original attempt in its own run directory, including interrupted and failed attempts.

Run the complete paired release comparison through `pnpm release:evaluate`; see [release workflow](releases.md). This launcher verifies the saved images and starts the offline Resolver worker. The underlying `pnpm evaluate:qualify` runner cannot start a complete collection by itself; filtered browser-only deterministic checks remain available. `pnpm evaluate:qualify:replay RUN_DIRECTORY` regrades saved comparison evidence without services or paid calls. A filtered check cannot replace the complete release comparison.

Replay reads the saved manifest, observations and original trials with their matching grader. It makes no provider calls and does not recreate the historical browser. Use the recorded source revision for older artifacts rather than applying today's policy to old approval claims.

## Release acceptance

The single current policy is `evaluation/policy.json`:

- Every case the approved baseline passes must also pass for the candidate. Gains elsewhere cannot offset a lost pass.
- Safety violations, operational failures, invalid contracts, missing required results and artifact mismatches fail the comparison.
- Existing semantic failures remain visible. Equality can pass when there are no lost passes and the required invariants hold.
- Median/p95 latency and reported/estimated/unknown costs are descriptive. Slow results and missing billing metadata are not release blockers.

There is one complete comparison, with no required pilot or fresh held-out phase. The collection grows as regressions and useful new cases are reviewed. Retain independent labels and all outcomes; do not retry away failures or claim generalization from repeatedly inspected cases.

Resolver HTTP timing includes capture, inference and live verification. Fixture setup and independent grading are outside the timer; these results do not measure the complete browser-to-chat experience. One-attempt results are observations of this run, not statistical guarantees.

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

`main` contains the selected resolver, release evaluation and the engineering comparison below. Retired model, dataset and context experiment runners are available at their recorded Git revisions. New alternatives belong on branches; accepted changes replace the selected implementation and prompt. See [ADR-0024](adr/0024-keep-one-resolution-implementation.md).

### Engineering comparison

Use **Basic resolver**, **Improved resolver** and **Stagehand** in reports and charts. Prompt versions belong in provenance. Basic is a verified archived bundle; Improved is built from the current checkout, with its source fingerprint and exact image IDs recorded. The application keeps one implementation.

```sh
pnpm evaluate:compare -- \
  --basic-bundle BASIC_BUNDLE_DIRECTORY --basic-sha256 MANIFEST_SHA256 \
  --case basic-save --output .artifacts/engineering-check

# Explicit paid comparison of every eligible shared browser case.
pnpm evaluate:compare -- --mode live \
  --basic-bundle BASIC_BUNDLE_DIRECTORY --basic-sha256 MANIFEST_SHA256 \
  --output .artifacts/engineering-live

pnpm evaluate:compare:replay .artifacts/engineering-live
uv run docs/assets/evaluation/engineering-plot.py .artifacts/engineering-live
```

The launcher verifies and restores the archived bundle, builds the current resolver and pinned Stagehand adapter, and starts an isolated evaluation stack. `--resume` with the original output directory continues only unattempted arms using the original image IDs; it rejects changed cases, grading or runtime images and unrecorded provider attempts. A fresh run gives its images unique local retention tags recorded in `image-tags.json`; keep those tags available for continuation. Set `XPATHED_EVALUATION_PROJECT=xpathed-evaluation-UNIQUE_NAME` for concurrent checkouts. A live run uses `OPENROUTER_EVAL_API_KEY`; scripted singleton and plural compatibility checks must pass before any paid calls.

All arms use the same case inputs and independent node labels. Browser binary, viewport, document checksum, initial state, language and time zone must match. Stagehand uses stock `observe` with a current-view instruction, one model call, no response reuse and no self-healing. The first singleton suggestion or complete plural set is graded; later suggestions cannot rescue an incorrect singleton. Explicit plural labels live with the shared cases.

The common score measures action and target-set correctness, passive behavior and privacy. Correct absence can pass without an action when Stagehand returns no suggestions; partially absent requests compare the found set. Full resolver-contract scores separately include readiness, capture coverage and outcome details. Adapter selector errors are failures, including on unsupported-instruction cases. Unsupported capabilities and provider errors stay in the denominator.

One worker runs each arm, so three isolated streams run concurrently. Each stream processes its frozen case order serially. Stagehand waits for the matching Basic browser observation before checking parity. There are no retries. Provider caching and host contention can affect latency; serial and parallel timing cohorts are reported separately. Retain every original request, response, charge and unknown charge locally. The export contains aggregate metrics, per-case outcomes and evidence hashes; it excludes page/provider payloads. Category charts use the shared behavior groups. Live browser results remain separate from imported offline selection and release approval.

### Continue a research comparison in parallel

`evaluation/research/parallel-comparison.mjs` continues a frozen paired research run with up to eight provider workers. One worker owns browser cases; the others run offline Resolver processes. Each worker has its own proxy state and charge ledger. A routing token selects the worker while the Resolver endpoint and configuration identity stay unchanged.

The operator first drains the original run, preserves its directory, and starts an isolated stack from the same verified candidate and baseline images. The continuation requires those artifact identities, an explicit `XPATHED_RESEARCH_CONTINUATION=true`, and a host offline worker with the matching concurrency. Inside that prepared stack:

```sh
node evaluation/research/parallel-comparison.mjs \
  --source ORIGINAL_RUN --output NEW_RUN --concurrency 8
```

The runner copies the frozen plan and evidence, retains completed successes and failures, and executes only missing arms. An unfinished attempted arm blocks continuation; it is never silently retried. Identity, response-reuse or evidence-integrity failures stop new work while active attempts drain.

Keep the phase manifest, per-arm claims, worker charge ledgers and before/after image receipts. Report serial and parallel latency cohorts separately because contention and cache conditions differ. This path produces research evidence; ordinary release comparison and approval remain unchanged.

Dated reports in `docs/research/` preserve their original scores, policies, limits and commands. See the [external dataset pilot](research/external-dataset-pilot-report.md), [labelled baseline](research/deepinfra-labelled-baseline-report.md), [Stagehand evidence](research/stagehand-v4-compatibility.md), [current-view comparison](research/viewport-baseline-report.md) and [context experiment](research/jev-context-comparison-report.md). Replay historical experiments from their recorded revision.

## Evidence and monitoring

A run saves its manifest, frozen cases and configuration, every original trial, summaries, and available provider evidence. Keep these artifacts private because sanitized page text can still be sensitive. Preserve source/image identity and approval history separately from expiring page/provider evidence. Run pruning does not erase the charge history or extend original retention deadlines.

After a new approval, nightly monitoring runs the entire approved live collection once against the exact approved images and compares with saved approval measurements. It uses one arm, preserves lost passes and operational failures, and never activates a release or changes the model. New cases enter monitoring only with the next approval. The existing `v1.0.0` approval continues through its archived runner and original sentinel receipt until a new-format approval replaces it. See [monitoring](releases.md#nightly-monitoring).
