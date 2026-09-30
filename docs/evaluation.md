# Independent resolution evaluation

Browser evaluation creates a fresh session for each trial and compares results with independently labelled targets and actions. External-dataset evaluation uses the same grading/reporting artifacts for offline target selection, with browser-dependent observations explicitly unavailable. Neither requires Web, ClientApi or PostgreSQL. Resolution never executes the requested interaction.

## Run a suite

```sh
pnpm evaluate
pnpm evaluate -- --repetitions 3 --seed 42
pnpm evaluate -- --case CASE_ID --output .artifacts/evaluation/my-run
pnpm evaluate:live -- --case CASE_ID
```

Deterministic mode is the default. It uses a local provider double to test contracts, fixtures and grading; its score does not measure model quality. Live mode explicitly calls the checked-in DeepSeek V4.1 Flash/Wafer route with a 4,096-token list output limit and reasoning disabled. This is a compatibility-check route, not a measured model recommendation. It reads `OPENROUTER_API_KEY` from the environment or the ignored `.env`; use `XPATHED_ENV_FILE` for another environment file. The initial external-dataset experiment below has a shared $5 ceiling and uses standard serving only. These separate browser-fixture live commands do not participate in that dataset ledger and must not be used to bypass its bound.

The wrapper starts only Browser, Resolver and the evaluation fixture in the separate `xpathed-evaluation` Compose project. It stops those containers on completion or failure and preserves artifacts. The development workspace is independent. For concurrent runs, set `XPATHED_EVALUATION_PROJECT` to a name beginning with `xpathed-evaluation-`; other project names are rejected before Docker is invoked. A lock prevents overlapping runs in one project. Existing containers from another checkout or belonging to services other than Browser, Resolver and the evaluation fixture are rejected before teardown. No host browser port is needed.

Output defaults to a new directory under ignored `.artifacts/evaluation/`. `--output` selects a new host directory, mounted as `/artifacts` in the runner. Existing output directories are rejected to protect previous evidence. Before starting evaluation services, a marker round-trip verifies Docker can read and write that exact host directory. With a VM-backed Docker engine such as Colima, choose a shared path under this checkout; an unshared temporary directory fails before any resolution calls. Defaults are one repetition, seed 1, sequential execution, no retries and a 45-second operation timeout. `--repetitions`, `--seed` and `--timeout-ms` declare changes before the run. A later rerun is a new artifact directory, not a replacement for the first attempt.

## Cases and oracles

`evaluation/cases.json` versions instructions, fixture/setup revisions, viewport, expected ordered actions and targets, state/readiness, request summaries, categories, family/split membership and label provenance. The declared managed viewport is 1280×800 with an explicit one-pixel tolerance for kiosk window bounds; each trial records its observed viewport. Related templates, paraphrases and mutations remain in one split. Expected node mappings live outside model-visible fixture content and provider requests. DOM identity establishes intended-target correctness; matching XPath text is not the oracle.

The fixture command channel independently observes returned XPath matches and expected nodes. Capture/model-input coverage, semantic selection, XPath identity, action decomposition, state/readiness, summary correctness, unsupported outcomes and operational errors remain separate checks. Saved-locator reuse after mutation is graded separately from fresh resolution; retaining a unique XPath that now identifies a distractor is a failure.

The initial labelled suite is development/regression evidence, not a genuine unseen holdout. Label review provenance is recorded rather than inferred from a green run. Future holdout cases must remain unexposed during tuning; once inspected or used to change behavior, move the entire related family to regression and replace the held-out family. Basic version-3 coverage grades one shared action and its complete distinct target set; historical version-2 action-list cases remain identified separately. Single-target external annotations do not establish multi-target coverage.

## External datasets

Prepare dependencies with the normal setup, then fetch pinned source assets and import them locally:

```sh
pnpm datasets:fetch --output .artifacts/datasets/sources
pnpm datasets:import --manifest .artifacts/datasets/sources/phrasenode-sources.json --output .artifacts/datasets/phrasenode-import
pnpm datasets:import --manifest .artifacts/datasets/sources/mind2web-sources.json --output .artifacts/datasets/mind2web-import
```

Fetching uses the official command/processed-page archives and one pinned Mind2Web training shard. Each asset has a fixed URL, size and independently checked SHA-256; an existing matching file is reused without a download. ZIP extraction reads only approved named members into regular files and refuses overwrite mismatches. It preserves PhraseNode's train/dev/test command files separately and excludes the duplicate `all` file. Raw HTML/CSS archives, source-session storage and current websites are not fetched. See the dated [PhraseNode](research/phrasenode-import-feasibility.md) and [Mind2Web](research/mind2web-import-feasibility.md) source research for attribution and reconstruction limits.

Import output must be a new directory. Relative source paths resolve against the manifest's directory; pass `--source-root DIRECTORY` when a reviewed manifest lives elsewhere. `manifest.json` retains original source URLs, checksums, splits, attribution and transformation version. `cases.json` retains per-record identities, independent target mappings and exclusion reasons; `inventory.json` records complete import denominators. Sanitized candidate inputs are deduplicated in `inputs/` by content hash. Family/split conflicts and invalid target mappings cannot become eligible cases. Imports do not call a model or execute source scripts.

Mind2Web's fetched shard is an identity/adaptation pilot, not the full corpus or a held-out suite. Its task-level descriptions are insufficient as independent single-step instructions. Optional manifest `adaptations` must record `annotationId`, `actionUid`, instruction, action, distinct author/reviewer identities, `reviewed:true`, `targetHiddenDuringAuthoring:true` and a policy version. The importer preserves the original interaction, including HOVER/ENTER before their source benchmark normalization. Unreviewed or conflicting adaptations remain visible exclusions. Never copy a gold action description into the input and report it as an independently authored instruction.

Run a reproducible diagnostic sample from one original split:

```sh
pnpm evaluate:dataset --import .artifacts/datasets/phrasenode-import --output .artifacts/datasets/phrasenode-run --split train --limit 30 --seed 1
pnpm evaluate:dataset --replay .artifacts/datasets/phrasenode-run
```

The default mode uses a simple lexical baseline with no provider call. It tests accounting and target grading; a poor score is an honest diagnostic result, not a model-quality measurement. A nonzero exit means the declared target expectations were not all met. The imported inventory stays complete even when the run samples only eligible cases. Select another split explicitly and use a new output directory for each run; source splits are not silently mixed. To process all eligible cases in a selected split, set `--limit` to its eligible count, within the runner's documented bound; inspect the written plan before treating a sampled report as whole-split evidence.

These source adapters support **offline target selection**. Rebuilding a DOM from processed nodes can validate mapping and XPath identity in that derivative document, but it does not reproduce historical geometry, visibility, hit testing or readiness. Browser replay and offline scores stay separate. No source record becomes a successful browser case merely because its synthetic rendering loads. Missing assets, unsupported scope, ambiguous labels and adaptation failures remain in the denominator report.

### Explicit live dataset pilot

Build the Resolver once with `pnpm build:dotnet`. The live runner invokes its offline selection entrypoint and existing gateway, without starting the application stack. It sends sanitized command/candidate input, not target-oracle fields. The current route is standard DeepSeek V4.1 Flash through Wafer; the broader model/prompt screening proposal remains future work, not an implemented comparison matrix or production model choice.

Review each complete instruction/candidate payload before provider submission. Sanitization removes known form values, frame subtrees and explicitly hidden content, but ordinary page text can still contain personal account details, location or search history. Public dataset availability does not make every captured page suitable for submission. Keep the review file private under `.artifacts/datasets/`; do not upload raw assets or payloads to CI or the repository.

The required `--reviewed-inputs` file has `version: 1` and an `entries` array. Each entry records `caseId`, `inputHash`, `reviewer`, an ISO `reviewedAt` timestamp and `providerSubmission: true`. Compute `inputHash` as SHA-256 of `JSON.stringify({ instruction: case.instruction, ...input })`, where `input` is the parsed imported input file. The runner selects only reviewed cases in the requested split and verifies their exact payload hashes before any provider call; changing the command or candidates requires a new review.

```sh
pnpm evaluate:dataset --import .artifacts/datasets/phrasenode-import --output .artifacts/datasets/phrasenode-live --split train --mode live --limit 3 --budget-usd 5 --reviewed-inputs .artifacts/datasets/phrasenode-reviewed-inputs.json
```

The approved initial experiment has a **$5 total ceiling**, shared across dataset live runs through `.artifacts/datasets/experiment-budget.json`. `--budget-usd` can lower that ceiling, not reset already recorded expenditure. Standard serving is used; no batch or paid CI job is configured. Before inference, the runner obtains current route prices, prepares the actual prompt/schema, reserves a conservative maximum request charge and saves that reservation. The offline evaluation entrypoint also sends provider `max_price` caps using those rates, as supported by [OpenRouter provider routing](https://github.com/OpenRouterTeam/docs/blob/main/guides/routing/provider-selection.mdx); application requests keep their existing routing behavior. Missing or excessive reported charges stop further calls; unreconciled reservations remain charged and block a later paid run until reviewed. Keep the ledger when removing temporary run directories; deleting it would erase experiment accounting.

Use the recorded token usage and route rates to forecast a larger selected sample before launching it. This bounded pilot does not qualify a release, establish a fastest model, or justify a full model-by-prompt-by-corpus experiment. The [experiment-design research](research/resolver-experiment-design.md) explains the separate proposed screening process and uncertainty limits.

## Artifacts and replay

Each run writes:

- `manifest.json`: the complete selected case definitions, declared trial order/settings, code/tree and dependency fingerprints, versions and incomplete qualification policy. Its configuration registry retains effective nonsecret gateway settings and prompt/schema hashes by configuration ID independently of expiring page evidence; it is enriched atomically as attempts finish.
- `trials/<attempt>.json`: each original result or operational failure, observations and permitted evidence, including separate mutation/fresh-resolution results.
- `summary.json`: separate grading and coverage results, timing/usage/cost aggregates and qualification status.
- `summary.txt`: a readable report of the same run.
- `imports/<attempt>.json`: version-1 diagnostic envelopes accepted by the [backend import contract](diagnostics.md).

```sh
pnpm evaluate:replay .artifacts/evaluation/RUN_DIRECTORY
pnpm diagnostics -- import < .artifacts/evaluation/RUN_DIRECTORY/imports/ATTEMPT_ID.json
```

Replay regrades the saved manifest and observations with the recorded grader revision. It uses no Docker, browser or provider. This reproduces a report from saved evidence; it does not reconstruct the historical browser or prove the saved XPath works on today's page. A mismatched manifest or grader is rejected, and missing planned trials remain failures.

Artifacts carry the ordinary 90-day and page-evidence 30-day retention policy. Backend imports enforce those bounds. Local artifact directories remain operator-owned and are not uploaded by CI. Run `node evaluation/run.mjs --prune RUN_DIRECTORY` for either browser or dataset run artifacts to remove expired evidence after 30 days or the complete run after 90 days. Cleanup is explicitly invoked; there is no local retention daemon. Deleting the entire local run within 30 days is a conservative option when separate evidence retention is unnecessary. Source downloads and dataset import directories are separate private caches; prune does not discover them. Remove them after the experiment or within the page-evidence window unless an explicit reviewed retention decision covers them. Keep the experiment charge ledger separately. Approved sanitized regression fixtures and qualification evidence require explicit review and retention decisions.

## Checks and limits

The command exits nonzero when declared deterministic identity/privacy/contract checks fail. Zero means those checks passed; numerical model-quality and latency thresholds are unset, so qualification remains incomplete and the result cannot approve a release. Unknown and missing observations remain explicit.

`pnpm check:tooling` runs Node tests for acquisition, adapters, runners, fixtures and grading, including negative controls. Evaluation source and manifest changes select that existing CI job. Tests use local synthetic samples, not source-corpus downloads or paid providers. Compose overlays are validated by the Docker configuration job. Neither CI job starts the evaluation services or makes paid calls; browser evaluation and live mode are explicit commands. Future release/quality gates remain governed by the live issue tracker.
