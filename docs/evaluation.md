# Independent resolution evaluation

The evaluator exercises Browser and Resolver directly. It creates a fresh browser session for each trial, compares results with separately labelled expected targets and actions, and writes artifacts for inspection or backend import. It does not require Web, ClientApi or PostgreSQL. Resolution still selects and observes targets; it never executes the requested interaction.

## Run a suite

```sh
pnpm evaluate
pnpm evaluate -- --repetitions 3 --seed 42
pnpm evaluate -- --case CASE_ID --output .artifacts/evaluation/my-run
pnpm evaluate:live -- --case CASE_ID
```

Deterministic mode is the default. It uses a local provider double to test contracts, fixtures and grading; its score does not measure model quality. Live mode explicitly calls the configured cheap OpenRouter route with the existing bounded response size. It reads `OPENROUTER_API_KEY` from the environment or the ignored `.env`; use `XPATHED_ENV_FILE` for another environment file. The checked-in route remains DeepSeek V4.1 Flash through Wafer, with a 4,096-token multi-action output limit and reasoning disabled. Paid usage and reported cost belong in the resulting artifacts; there is no monetary qualification cap.

The wrapper starts only Browser, Resolver and the evaluation fixture in the separate `xpathed-evaluation` Compose project. It stops those containers on completion or failure and preserves artifacts. The development workspace is independent. For concurrent runs, set `XPATHED_EVALUATION_PROJECT` to a name beginning with `xpathed-evaluation-`; other project names are rejected before Docker is invoked. A lock prevents overlapping runs in one project. Existing containers from another checkout or belonging to services other than Browser, Resolver and the evaluation fixture are rejected before teardown. No host browser port is needed.

Output defaults to a new directory under ignored `.artifacts/evaluation/`. `--output` selects a new host directory, mounted as `/artifacts` in the runner. Existing output directories are rejected to protect previous evidence. Before starting evaluation services, a marker round-trip verifies Docker can read and write that exact host directory. With a VM-backed Docker engine such as Colima, choose a shared path under this checkout; an unshared temporary directory fails before any resolution calls. Defaults are one repetition, seed 1, sequential execution, no retries and a 45-second operation timeout. `--repetitions`, `--seed` and `--timeout-ms` declare changes before the run. A later rerun is a new artifact directory, not a replacement for the first attempt.

## Cases and oracles

`evaluation/cases.json` versions instructions, fixture/setup revisions, viewport, expected ordered actions and targets, state/readiness, request summaries, categories, family/split membership and label provenance. The declared managed viewport is 1280×800 with an explicit one-pixel tolerance for kiosk window bounds; each trial records its observed viewport. Related templates, paraphrases and mutations remain in one split. Expected node mappings live outside model-visible fixture content and provider requests. DOM identity establishes intended-target correctness; matching XPath text is not the oracle.

The fixture command channel independently observes returned XPath matches and expected nodes. Capture/model-input coverage, semantic selection, XPath identity, action decomposition, state/readiness, summary correctness, unsupported outcomes and operational errors remain separate checks. Saved-locator reuse after mutation is graded separately from fresh resolution; retaining a unique XPath that now identifies a distractor is a failure.

The initial labelled suite is development/regression evidence, not a genuine unseen holdout. Label review provenance is recorded rather than inferred from a green run. Future holdout cases must remain unexposed during tuning; once inspected or used to change behavior, move the entire related family to regression and replace the held-out family. Broader datasets and independently graded baselines remain in their linked issues.

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

Artifacts carry the ordinary 90-day and page-evidence 30-day retention policy. Backend imports enforce those bounds. Local artifact directories remain operator-owned and are not uploaded by CI. Run `node evaluation/run.mjs --prune RUN_DIRECTORY` to remove expired evidence after 30 days or the complete run after 90 days. Cleanup is explicitly invoked; there is no local retention daemon. Deleting the entire local run within 30 days is a conservative option when separate evidence retention is unnecessary. Approved sanitized regression fixtures and qualification evidence require explicit review and retention decisions.

## Checks and limits

The command exits nonzero when declared deterministic identity/privacy/contract checks fail. Zero means those checks passed; numerical model-quality and latency thresholds are unset, so qualification remains incomplete and the result cannot approve a release. Unknown and missing observations remain explicit.

`pnpm check:tooling` runs Node tests for the runner, fixtures and grader, including negative controls. Evaluation source and manifest changes select that existing CI job. Compose overlays are validated by the Docker configuration job. Neither CI job starts the evaluation services or makes paid calls; browser evaluation and live mode are explicit commands. Future release/quality gates remain governed by the live issue tracker.
