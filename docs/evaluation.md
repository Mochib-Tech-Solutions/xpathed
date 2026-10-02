# Independent resolution evaluation

Evaluation answers whether the resolver selected the intended targets, interpreted the action correctly, and returned verified XPath and state information. Independent labels define the expected answer; a unique XPath alone cannot establish intended-target correctness. Resolution inspects and highlights targets without executing the requested interaction.

[ADR-0023](adr/0023-simplify-release-evaluation.md) defines the accepted simplification. This runbook describes the new source layout and workflow contract; it does not establish that hosted workflows, private dataset publication, or live qualification have been exercised. The existing approved release keeps its original evidence until replaced.

## One collection, grouped by behavior

```text
evaluation/
  cases/          # Shared browser cases grouped by behavior, with one loader
  fixtures/       # Controlled pages and independent target oracles
  datasets/       # Source adapters and the reviewed private collection manifest
  research/       # Stagehand, model and context comparisons
  accounting/     # Shared charge records
  run.mjs         # Browser trials and replay
  compare.mjs     # Candidate/baseline and monitoring orchestration
  grader.mjs      # Independent grading
  policy.json     # One current release acceptance policy
  profiles.json   # Explicit model/provider configurations
  provider.mjs    # Shared provider integration
scripts/release/  # Images, evidence, approval, activation and rollback
```

Cases are organized by the behavior they check, rather than by the version that introduced them. The shared loader also serves deterministic CI. Legacy compatibility, injected-provider failures and saved-locator mutation cases remain engineering checks; selection records why they are excluded from live release inference. Unit, integration and UI tests keep their existing locations and ordinary CI ownership.

Each release comparison freezes the complete eligible browser collection and every reviewed eligible imported case. Both candidate and approved baseline receive the same case inputs and current grading rules, with one original attempt per arm. Browser state resets independently. New cases and improved checks are welcome: apply the same updated expectations to both arms. Changing the collection or grader after a run requires another comparison.

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

Deterministic mode is the default. A controlled provider response makes fixtures, contracts and grader checks repeatable; those results are not model-quality scores. Live mode calls the configured route. Use `OPENROUTER_EVAL_API_KEY` in the environment or ignored evaluation environment file. Keep the application's key separate; deterministic CI receives no provider credentials.

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

After the pinned private asset is published, obtain and verify it with:

```sh
pnpm datasets:collection fetch
```

The current local archive and pinned manifest are prepared. The intended `evaluation-data/reviewed-72d140c1.json.gz` asset has not yet been published. Hosted release evaluation therefore still needs that publication before fetching can succeed. A missing or changed required dataset fails completeness checks; it must not silently reduce the release denominator.

The source acquisition and adaptation commands remain `pnpm datasets:fetch`, `pnpm datasets:import`, and `pnpm evaluate:dataset`. Use the checked-in source manifests and each command's options for a research cohort. Keep imported, excluded, unsupported, ambiguous and unreconstructible records visible with reasons. Dataset terms and submission review remain required even when cost is unrestricted.

## Cost and provider evidence

Track estimates, token usage, provider generation IDs, reported charges and unknown amounts separately. Cost amounts, estimate overruns, missing prices, unavailable billing metadata and accounting-service availability do not stop resolution evaluation or reject a release. Preserve charge records where available and report accounting failures explicitly; never invent a zero charge.

Authentication, transport failures, provider rejection and missing resolution results are operational failures. A provider-enforced key limit can reject a call, but the evaluator adds no monetary continuation gate. Keep the dedicated evaluation key, standard routes, original attempts and existing charge history. Successful billing reconciliation never turns a failed model response into a passing case.

## Research comparisons

Research remains part of the interview assignment. It uses shared fixtures, provider integration, grading and evidence while keeping source-specific limitations explicit. It is not an additional sequence required on every release PR.

### Compare the custom resolver and Stagehand

`pnpm evaluate:compare` compares the resolver with the pinned Stagehand adapter. A browser-parity check establishes equivalent Chromium, page state and fixture documents. Singleton commands grade the first suggestion; plural commands grade the whole set. Stagehand uses observation only and does not execute actions. Replay uses `pnpm evaluate:compare:replay RUN_DIRECTORY`.

### Compare and qualify models

Model profiles permit controlled comparisons of explicit routes and settings. Record prompt or provider changes so a whole-configuration comparison is not mistaken for a model-only result.

### External datasets

Dataset experiments retain original source/split denominators and explicit prompt variants. Preparation and forecasts are informational; reviewed exact input identities remain binding.

### Context-planning experiment

The context-planning experiment, `pnpm evaluate -- --context`, tests optional CSS/layout evidence with a fixed final model and preserved candidates. It remains evaluation-only; findings do not automatically change runtime settings.

Dated reports in `docs/research/` preserve their original scores, policies, limits and commands. See the [external dataset pilot](research/external-dataset-pilot-report.md), [labelled baseline](research/deepinfra-labelled-baseline-report.md), [Stagehand evidence](research/stagehand-v4-compatibility.md), [current-view comparison](research/viewport-baseline-report.md) and [context experiment](research/jev-context-comparison-report.md). Replay historical experiments from their recorded revision.

## Evidence and monitoring

A run saves its manifest, frozen cases and configuration, every original trial, summaries, and available provider evidence. Keep these artifacts private because sanitized page text can still be sensitive. Preserve source/image identity and approval history separately from expiring page/provider evidence. Run pruning does not erase the charge history or extend original retention deadlines.

After a new approval, nightly monitoring runs the entire approved live collection once against the exact approved images and compares with saved approval measurements. It uses one arm, preserves lost passes and operational failures, and never activates a release or changes the model. New cases enter monitoring only with the next approval. The existing `v1.0.0` approval continues through its archived runner and original sentinel receipt until a new-format approval replaces it. See [monitoring](releases.md#nightly-monitoring).
