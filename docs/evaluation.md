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

## Compare the custom resolver and Stagehand

```sh
pnpm evaluate:compare -- --case basic-save --output .artifacts/evaluation/comparison-check
pnpm evaluate:compare -- --case basic-save --mode live --output .artifacts/evaluation/comparison-live
pnpm evaluate:compare:replay .artifacts/evaluation/comparison-live
```

The default deterministic mode checks adapter compatibility with controlled responses. Omit `--case` to run the declared comparison subset; use `--repetitions` and `--seed` to declare repeated trials. Each pair gets separate fresh fixture pages. The custom resolver uses contract 3; the standalone adapter pins Stagehand 4.1.0 and calls only `observe`. It preserves Stagehand's prompt and DOM representation, so the result compares whole configurations even when model/provider settings match. It changes neither the production resolver nor the client.

Before either arm performs inference, the runner requires matching Chromium binary hashes, viewport, user agent, locale, timezone, initial scroll/focus/field structure and normalized fixture-document checksums. The document checksum detects controlled-fixture differences; it is not a security hash. Source and dependency fingerprints retain the code inputs. The adapter's extension and CDP connection live only in its isolated evaluation container, using the same pinned Chromium build and sandbox policy. No production browser control port or Browserbase account is added. Stagehand's separate `evaluation/stagehand/package-lock.json` is installed in that Docker image, outside ordinary workspace dependency installation and tooling CI.

**Singleton requests grade the first suggestion; explicit plural requests grade the whole returned set.** A wrong first suggestion remains wrong even if a later suggestion is correct. Plural results are order independent, with missing, extra, duplicate and wrong nodes reported separately. The oracle receives expected labels only after inference and independently evaluates each document-scoped XPath and its explicit frame chain. Accessibility-hidden nodes are excluded; offscreen and disabled nodes can still be legitimate targets. Interaction methods must match the shared requested action. An empty observation has no inferred action and records action availability accordingly. Stagehand readiness remains unavailable rather than borrowing the custom resolver's observations. Selector-conversion failures, unsupported scope, empty results and operational failures remain distinct; neither adapter executes actions, retries inference or uses self-healing to repair a selection.

Every live comparison first runs the deterministic basic and plural compatibility gate. Both must pass before the runner initializes the paid proxy or submits a provider request. Live comparison uses the standard DeepSeek V4.1 Flash/Wafer route with reasoning disabled and a 4,096-token output limit. Both arms pass through the same local budget proxy, sharing `.artifacts/datasets/experiment-budget.json` with the initial dataset experiment and its **$5 total ceiling across all runs**. Every actual generation must reserve a conservative charge before submission and apply current provider price caps. Missing or excessive reported charges stop further paid requests. Preserve the ledger when deleting run artifacts. No priority or fast tier is enabled. Provider prompt-cached tokens are distinct from response reuse; fresh local observations and actual request evidence establish which path ran.

Comparison directories retain `manifest.json`, each original `trials/` entry, `summary.json` and live `provider/` request/response evidence. Every planned strategy attempt remains in the report denominator, including errors and unsupported cases. Singleton and plural results stay separate. Replay requires the matching manifest and grader and regrades retained observations without services or provider calls. It does not rerun the browser. Keep these directories private because provider evidence can contain page text. The ordinary `node evaluation/run.mjs --prune RUN_DIRECTORY` command removes comparison page/provider evidence after 30 days and the complete run after 90 days; comparison manifests use version `"1"` and need no diagnostic imports. Preserve the separate charge ledger. These development cases and small live pilots do not qualify a release or establish a model default. See the dated [Stagehand compatibility research](research/stagehand-v4-compatibility.md) for the pinned API evidence and its limits.

## Compare and qualify models

The dated [qualification report](research/model-qualification-report.md) records measured latency, correctness, costs and the decision to leave defaults unchanged.

`pnpm evaluate:qualify` uses the same browser execution and independent grader, with the profiles in `evaluation/qualification-profiles.json`. It compares the baseline prompt/schema/DOM on standard Luna/OpenAI, Gemini/Google AI Studio and DeepSeek/Wafer routes; `--profile qwen` adds Qwen3.8 Flash/Alibaba with reasoning disabled. Model-specific reasoning and caching settings are explicit, fingerprinted and checked against current endpoint metadata. The optional `deepseek-concise` profile changes only the contract-3 prompt and records its own prompt version; it is an experimental development variant. Application defaults stay unchanged.

```sh
pnpm evaluate:qualify -- --mode deterministic --split development,regression --output .artifacts/evaluation/qualification-contracts
pnpm evaluate:qualify -- --mode deterministic --profile luna,gemini,deepseek,qwen --repetitions 1 --output .artifacts/evaluation/qualification-pilot
pnpm evaluate:qualify -- --mode deterministic --split regression --profile luna,gemini,deepseek,qwen --repetitions 1 --output .artifacts/evaluation/qualification-confirmation
pnpm evaluate:qualify:replay .artifacts/evaluation/qualification-confirmation
```

The pilot is development evidence. The 2026-09-30 held-out families are now regression with `previousSplit` and exposure-run provenance. Current runs cannot qualify a release until fresh independent held-out families are added; the second command above is a deterministic regression comparison. Historical policy-1 artifacts remain unchanged and replay requires their recorded source revision. Confirmation checks its configuration and source fingerprints, forecasts cost from recorded input/output token distributions at fresh endpoint rates, and freezes the policy before held-out calls. Never change settings or thresholds in response to held-out results: move exposed families to regression before another tuning cycle. A run uses seeded case order, rotates profile order, executes one request at a time, and retains every original attempt without retries or discarded warmups. Provider prompt-cache warmth is uncontrolled and recorded separately from response caching. The proxy sends `X-OpenRouter-Cache: false`; cached responses or mismatched identities are invalid fresh-inference evidence.

`evaluation/qualification-policy.json` declares policy 2: a **strictly sub-1-second goal and inclusive 2-second deadline**. At least 95% of all planned requests must be correct and complete within the deadline; errors, wrong actions, missing/extra targets and timeouts fail it. Correctness must also reach 95% overall and in each required split, with an 80% family floor and no critical/invariant failure. The minimum held-out coverage is ten distinct fixture families and thirty trials, not a statistical guarantee. Reports retain family-level uncertainty; repeating one template does not create independent evidence. Development capability gaps and critical failures remain visible when considering confirmation.

Timing covers the Resolver HTTP request, including capture, inference and live same-node XPath/readiness verification. Fixture setup and the independent oracle run outside that timer. Endpoint price lookup uses the proxy's frozen metadata snapshot; production currently fetches that metadata over the network. These measurements therefore describe the evaluation resolver path, not guaranteed browser-to-chat UI latency. Stage timings and all-attempt latency remain separate from correct-only latency.

Before paid calls, deterministic positive, absent, scoped/plural and provider-failure checks exercise the same services. Live calls reserve charges through the **existing shared $5 ledger**. Missing usage/charges stop further paid work; preserve reservations until reconciled. No premium serving tier, response healing, fallback model or automated CI spending is enabled.

The qualification manifest links source/dependency/browser fingerprints, full selected cases and exclusions, policy, route metadata and configuration identities. Per-trial artifacts retain nonsecret effective settings and expiring page/provider evidence. Replay uses the recorded runner and grader, checks manifest/trial identities and recomputes results without services. A completed measurement can exit successfully with **no qualified candidate**; inspect the qualification status rather than treating process success as approval. There is no automatic default promotion.

The original legacy contract and saved-locator mutation suite remains separate. Imported PhraseNode and Mind2Web cases retain original split identities and offline-only limitations; these controlled browser results do not claim those corpora were rerun or that reconstructed DOMs reproduce historical readiness. Appearance-only commands expose a known gap: the baseline capture carries geometry but not computed color. That limitation must not disappear into an aggregate score or a full-scope release claim.

## Cases and oracles

`evaluation/cases.json` versions instructions, fixture/setup revisions, viewport, expected ordered actions and targets, state/readiness, request summaries, categories, family/split membership and label provenance. The declared managed viewport is 1280×800 with an explicit one-pixel tolerance for kiosk window bounds; each trial records its observed viewport. Related templates, paraphrases and mutations remain in one split. Expected node mappings live outside model-visible fixture content and provider requests. DOM identity establishes intended-target correctness; matching XPath text is not the oracle.

The fixture command channel independently observes returned XPath matches and expected nodes. Reports count missing, extra, duplicate and wrong targets separately and expose whole-target-set completeness. Extra returned entries include wrong nodes and duplicate occurrences; the duplicate count identifies the latter. Capture/model-input coverage, semantic selection, XPath identity, action decomposition, state/readiness, summary correctness, unsupported outcomes and operational errors remain separate checks. Saved-locator reuse after mutation is graded separately from fresh resolution; retaining a unique XPath that now identifies a distractor is a failure.

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

Offline live runs accept `--prompt-variant baseline` (default) or `--prompt-variant declarative-inspect`. The latter appends one experimental clarification: a target description without an explicit action verb means `inspect`; genuine ambiguity, plural target rules and unsupported workflows are preserved. It changes only the versioned system prompt, not the original instruction, candidate payload, schema or production defaults. The prepared request, sent request and retained configuration share that prompt and its version. Deterministic lexical runs reject experimental variants because they do not execute a model prompt.

Use this only after choosing a model from the common-baseline comparison. Reuse original development baseline attempts, freeze a family-diverse tuning subset and run each new variant once per case. Confirm baseline versus the chosen variant on separately frozen, unexposed labelled families; do not tune from those confirmation outputs. Existing privacy reviews, standard provider profiles and the shared $5 ledger remain required. Original target labels do not establish action/readiness correctness or app-wide qualification. See [issue #34](https://github.com/Mochib-Tech-Solutions/xpathed/issues/34).

These source adapters support **offline target selection**. Rebuilding a DOM from processed nodes can validate mapping and XPath identity in that derivative document, but it does not reproduce historical geometry, visibility, hit testing or readiness. Browser replay and offline scores stay separate. No source record becomes a successful browser case merely because its synthetic rendering loads. Missing assets, unsupported scope, ambiguous labels and adaptation failures remain in the denominator report.

For a PhraseNode identity check, `evaluation/reconstruction.mjs` creates a sanitized static tree and a unique original-node-to-selector mapping. It verifies imported-case, command, page and candidate-input checksums, confines source paths to the supplied root, removes scripts/assets/form values and rejects parser changes that break the mapping. Regenerate the Home pilot from the pinned import with:

```sh
node evaluation/reconstruction.mjs --import .artifacts/datasets/phrasenode-import --source-root .artifacts/datasets/sources --case phrasenode-666c99296b76c2f02bb28f50 --output .artifacts/datasets/phrasenode-browser-suite.json
pnpm evaluate --suite .artifacts/datasets/phrasenode-browser-suite.json --output .artifacts/evaluation/phrasenode-derived-pilot
```

The output must be a new private file. Construction validates source identity automatically; it does not claim independent human label review. The provider double uses a controlled click probe, recorded as `actionLabelSource: controlled-browser-probe`; PhraseNode does not supply an annotated action. Its original instruction and target remain unchanged. Custom suites support deterministic mode only. Report these trials as derivative DOM identity checks with historical state unavailable, not model quality or source action accuracy.

### Explicit live dataset pilot

Restore dependencies with `pnpm restore:dotnet`. The live runner builds the current Resolver before freezing its manifest and invokes its offline selection entrypoint and existing gateway, without starting the application stack. It sends sanitized command/candidate input, not target-oracle fields. The offline dataset runner defaults to standard DeepSeek V4.1 Flash through Wafer. `--profile qwen` or `--profile gemini` selects the same approved baseline settings as the browser matrix, using the shared budget proxy; prompt variants are excluded. Each profile uses a separate output directory and the same reviewed sample/seed for comparison. The browser matrix evaluates controlled cases; offline source results remain a separate track. Offline elapsed time includes input preparation and .NET process startup, with provider timing reported separately; neither establishes browser or UI response latency.

Review each complete instruction/candidate payload before provider submission. Sanitization removes known form values and prunes frame and explicitly concealed subtree text before collecting ancestor text. Ordinary page text can still contain personal account details, location or search history. Public dataset availability does not make every captured page suitable for submission. Keep the review file private under `.artifacts/datasets/`; do not upload raw assets or payloads to CI or the repository.

The required `--reviewed-inputs` file has `version: 1` and an `entries` array. Each entry records `caseId`, `inputHash`, `reviewer`, an ISO `reviewedAt` timestamp and `providerSubmission: true`. Compute `inputHash` as SHA-256 of `JSON.stringify({ instruction: case.instruction, ...input })`, where `input` is the parsed imported input file. The runner selects only reviewed cases in the requested split and verifies their exact payload hashes before any provider call; changing the command or candidates requires a new review.

```sh
pnpm evaluate:dataset --import .artifacts/datasets/phrasenode-import --output .artifacts/datasets/phrasenode-qwen-pilot --split dev --mode live --profile qwen --limit 10 --budget-usd 5 --reviewed-inputs .artifacts/datasets/phrasenode-reviewed-inputs.json
```

The approved initial experiment has a **$5 total ceiling**, shared across dataset and comparison live runs through `.artifacts/datasets/experiment-budget.json`. `--budget-usd` can lower that ceiling, not reset already recorded expenditure. Standard serving is used; no batch or paid CI job is configured. Before inference, the runner obtains current route prices, prepares the actual prompt/schema, reserves a conservative maximum request charge and saves that reservation. The shared proxy pins the approved route/settings, disables response reuse, retains model/provider/cache metadata and reconciles every charge. Route/cache/charge failures stop further paid calls; the application configuration is unchanged. Missing or excessive reported charges stop further calls; unreconciled reservations remain charged and block a later paid run until reviewed. Keep the ledger when removing temporary run directories; deleting it would erase experiment accounting.

For a broader comparison, freeze a reviewed sample spanning page families and candidate-count ranges before observing model output. For the current comparison, use one identical baseline prompt and one attempt per original labelled case per model. Do not generate instruction paraphrases, guess missing action labels or correct uncertain target annotations: exclude concerns before inference and retain their reasons. Authored browser fixtures remain deterministic engineering checks, outside source-based model-quality scores. Use a stratified pilot that includes the largest selected input, then forecast only the remaining cases for each model from measured usage and current route rates. Pilot cases count toward the total; use disjoint pilot and remainder review files so no case is submitted twice for a model. For this offline track, a frozen candidate queue can run in affordable waves: budget the entire next all-model wave with the existing twice-observed-maximum forecast and current bounded prices, reconcile it, then forecast the next wave using all retained observations. Never schedule by accuracy or drop costly attempts. Stop when no complete wave fits and report planned versus attempted coverage; this does not bypass the browser qualification confirmation gate. Preserve source-label concerns separately rather than silently correcting annotations or attributing every disagreement to the model. Use the recorded token usage and route rates to forecast a larger selected sample before launching it. This bounded pilot does not qualify a release, establish a fastest model, or justify a full model-by-prompt-by-corpus experiment. The [experiment-design research](research/resolver-experiment-design.md) explains the separate proposed screening process and uncertainty limits.

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

The ordinary evaluator exits nonzero when declared deterministic identity/privacy/contract checks fail. Its zero exit means those checks passed and does not approve a release. The separate model qualification runner applies the versioned policy above and can record a completed experiment with no qualifying model. Unknown and missing observations remain explicit.

`pnpm check:tooling` runs Node tests for acquisition, adapters, runners, fixtures and grading, including negative controls. Evaluation source and manifest changes select that existing CI job. Tests use local synthetic samples, not source-corpus downloads or paid providers. Compose overlays are validated by the Docker configuration job. Neither CI job starts the evaluation services or makes paid calls; browser evaluation and live mode are explicit commands. Future release/quality gates remain governed by the live issue tracker.
