![xpathed — one golden path finds an illuminated target in a vast web tree on a torn celestial map](docs/assets/banner.svg)

# Natural-language to XPath resolver

[![CI](https://github.com/Mochib-Tech-Solutions/xpathed/actions/workflows/check.yml/badge.svg?branch=main&event=push)](https://github.com/Mochib-Tech-Solutions/xpathed/actions/workflows/check.yml)
![.NET 10](https://img.shields.io/badge/.NET-10-512BD4?logo=dotnet&logoColor=white&labelColor=161b22)
![React 19 and TypeScript 6](https://img.shields.io/badge/React_19-TypeScript_6-3178C6?logo=react&logoColor=61DAFB&labelColor=161b22)

xpathed is a Resolver API that turns English instructions into verified XPath expressions for the current browser view. The Resolver is the core system. It uses a browser service through HTTP APIs; the included chat workspace is a client for manual testing and demonstrations.

**The model selects elements; browser code builds and verifies their XPaths.** Independent evaluation checks whether those elements were the intended targets.

<img src="docs/assets/saucedemo-demo.gif" alt="Sauce Demo: finding Login, highlighting the button, and zooming into its XPath and verification" width="720" />

On [Sauce Demo](https://www.saucedemo.com/), “Click the Login button” finds and highlights Login, then returns its verified XPath. The form stays untouched.

## Try an instruction

> Hover over OK under Employee.

xpathed uses section context to distinguish repeated buttons. On a page with suitable markup, an illustrative result is:

```text
Button · OK
Action: hover
XPath: //*[@aria-label='Employee']//button[normalize-space(.)='OK']
Verification: one match, same captured node, still in the current view
```

The actual XPath comes from the DOM. Results include readiness, time and cost. A blocked action appears as one red explanation naming the target and why the action is unavailable, without an XPath card or repeated state labels. You browse manually; the resolver highlights targets without executing the instruction.

XPath construction prefers explicit test attributes and meaningful semantics. It distinguishes sanitized names from DOM text so Unicode and nested labels can retain semantic locators across wrapper changes, while excluding hidden text and form values from new text predicates. The [selection policy](docs/resolution.md#preferred-xpath) describes the bounds and saved-locator limits.

## Clone and run locally

Install **Node 24.16.0**, **pnpm 12.8.1**, and **Docker with Compose and Buildx**. Chromium needs the [documented Linux sandbox support](docs/runtime.md#sandbox-and-supported-environment).

```sh
git clone https://github.com/Mochib-Tech-Solutions/xpathed.git
cd xpathed
pnpm run setup
```

Setup creates an ignored `.env` from `.env.example` without replacing an existing file. Supply the application settings:

```dotenv
OPENROUTER_API_KEY=your-key-here
OPENROUTER_MODEL=deepseek/deepseek-v4.1-flash
OPENROUTER_PROVIDER=wafer
```

```sh
pnpm dev
```

Open **[localhost:8080](http://localhost:8080)**, enter a website address and submit an instruction. Manual browsing works without a key; live resolution uses your OpenRouter account.

All four services run in Docker. Ctrl+C or `pnpm docker:down` removes development containers while preserving configuration. A separate checkout needs its own `COMPOSE_PROJECT_NAME`, `XPATHED_PORT` and `.env`.

## Run the published Docker release

The release contains **Browser** and **Resolver** images for **Linux ARM64**, matching CI. Install Docker with Compose and authenticate `gh` for this private repository. Download the release assets, reassemble and verify the image archive, then supply your runtime settings:

```sh
gh release download v1.0.0 --repo Mochib-Tech-Solutions/xpathed --dir xpathed-release
cd xpathed-release
cat browser-resolver-images.tar.gz.part-* | gzip -dc > images.tar
shasum -a 256 -c SHA256SUMS
docker image load --input images.tar
cp release.env.example .env
# Edit .env: supply OPENROUTER_API_KEY, OPENROUTER_MODEL and OPENROUTER_PROVIDER.
docker compose --env-file .env --env-file images.env -f compose.release.yaml up -d --no-build --pull never
curl --fail http://localhost:8082/health  # Browser
curl --fail http://localhost:8083/health  # Resolver
```

Run each step only after the previous one succeeds. On Linux, `sha256sum --check SHA256SUMS` is equivalent to `shasum`. The [GitHub Releases page](https://github.com/Mochib-Tech-Solutions/xpathed/releases) lists available tags; use a fresh download directory for each deployment. No repository clone, Node or pnpm is needed for this path. `images.env` pins the exact Docker IDs. Compose starts those images without rebuilding; `pnpm dev` builds the current local checkout instead. Local source builds support the Docker host's architecture.

From an existing clone, `pnpm release:download --output .artifacts/deployment` performs download, integrity checks and image loading for the current `release` commit automatically, then supplies the same Compose files.

Browser listens on `localhost:8082`; Resolver on `localhost:8083`, and connects to Browser over the Compose network. These are API services; the chat workspace is available through the source setup above. See the [API example](docs/releases.md#use-the-apis) and [release files and configuration](docs/releases.md#run-the-published-browser-and-resolver).

Stop this deployment from its directory:

```sh
docker compose --env-file .env --env-file images.env -f compose.release.yaml down
```

## Architecture

The Resolver accepts instructions from a client or evaluation runner, coordinates capture and model selection, and returns targets verified by the browser service. Browser implementations connect through the [browser API contract](docs/runtime.md#browser-integration). The bundled implementation uses Playwright/Chromium.

[![Service ownership and request paths](docs/diagrams/system-design.svg)](docs/diagrams/system-design.svg)

The diagram includes the bundled test client.

| Service                       | Responsibility                                                                |
| ----------------------------- | ----------------------------------------------------------------------------- |
| Resolver — ASP.NET Core       | Core resolution API, model selection and orchestration                        |
| Browser — Playwright/Chromium | Browser API implementation: pages, capture, XPath verification and highlights |
| Web — React/TypeScript        | Manual test client: chat, tabs and noVNC viewer                               |
| ClientApi — ASP.NET Core      | Test-client requests                                                          |

Resolver runs independently of Web and ClientApi. It addresses Browser through `BrowserUrl`, exchanging serializable records defined in `src/Common`. A replacement browser service must preserve the capture, identity, verification and lifecycle contracts; only the bundled implementation has been verified. The test client's viewer and Resolver address the same managed page.

The repository follows these boundaries: `src/Resolver` contains the core system, `src/Browser` the browser implementation, `src/Common` the shared contracts, and `src/Web` plus `src/ClientApi` the test client. `evaluation/` evaluates the Resolver directly.

## How resolution works

[![Resolver internals: model selects candidate IDs; browser code constructs and verifies XPath](docs/diagrams/resolver-internals.svg)](docs/diagrams/resolver-internals.html)

The request crosses six boundaries. Each step uses the previous step's evidence and has a specific completion condition.

| Step and owner                       | Requires                                                    | Produces                                                                 |
| ------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1. Accept — Resolver                 | Instruction, active page and current document ID            | Validated request                                                        |
| 2. Capture — Browser                 | Live page and supported frame documents                     | Complete scoped candidates, capture ID and retained nodes                |
| 3. Select — model through OpenRouter | Instruction, sanitized candidates, prompt and output schema | Shared action, candidate IDs and found/absent/unsupported outcomes       |
| 4. Validate — Resolver               | Model output and the captured candidate set                 | Schema-checked selection with valid IDs and no duplicates                |
| 5. Verify — Browser                  | Capture ID, selections and retained live nodes              | Unique same-node XPath, frame context, current-view checks and readiness |
| 6. Return — Resolver                 | Verified Browser observations and provider usage            | API result with target outcomes, limitations, timings and cost           |

Model selection covers steps 3–4. XPath construction and verification covers step 5. Resolver E2E covers the complete request. The model has no browser tools and returns element IDs; Browser constructs the XPath. The [walkthrough](docs/how-it-works.md#step-boundaries) explains the limits and failure conditions at each handoff.

### Model and configuration

The development default is **`deepseek/deepseek-v4.1-flash` through OpenRouter's `wafer` provider**, configured in `.env.example` and `docker/compose.yaml`.

The repository keeps one implementation and one prompt/schema, updated in place. Git tracks their history; code has no manual prompt or behavior revision numbers. See [ADR-0024](docs/adr/0024-keep-one-resolution-implementation.md).

`ActionSelectionStrategy` owns the shared runtime/offline prompt, schema and selection validation. `OpenRouterGateway` pins the provider, disables reasoning and fallback, and limits output to 4,096 tokens. A configuration hash identifies effective settings. No model is trained here; changes to the pretrained model, prompt or context require evaluation. Docker/environment variables supply OpenRouter credentials, endpoint, model and provider. Release artifacts do not override deployment configuration.

Illustrative saved click result:

```text
Target: Save in Profile
XPath: verified against the selected button
Readiness: blocked — button disabled
```

## Scope

Resolve one English action across one or more current-view targets, including nested iframe targets. Off-screen elements require manual scrolling and another request. Mixed actions, sequential workflows, shadow-root XPath targets and image-pixel interpretation are unsupported. Readiness describes observed state, not successful execution.

This is a local application. Hosted use needs authentication, network isolation and session capacity management.

## Evaluation

The **evaluation set** has three categories, scored separately:

| Category                            | What it checks                                                                                                         | Command                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Model selection                     | Real model selects the expected element from reviewed saved candidates, currently PhraseNode                           | `pnpm evaluate:model:live`    |
| XPath construction and verification | Controlled selections go directly to Browser; independent DOM labels check XPath identity, state and locator mutations | `pnpm evaluate:xpath`         |
| Resolver E2E                        | Instruction → real browser capture → real model → verified XPath and final response                                    | `pnpm evaluate:resolver:live` |

`pnpm evaluate` runs all three and writes separate results plus a combined summary. **It makes paid model calls** for model selection and Resolver E2E; XPath evaluation needs no provider key. Live commands use `OPENROUTER_EVAL_API_KEY`. Fetch the reviewed inputs with `pnpm datasets:collection fetch` if they are not already available. Imported accuracy cases also require a pinned semantic review of the expected target against the supplied input; ambiguous or unanswerable labels remain documented exclusions. See the [dataset review contract](docs/evaluation.md#private-dataset-collection).

“Offline” describes the saved inputs used for model selection, which still calls a live model. XPath evaluation supplies known selections to isolate the stage after inference. E2E checks whether both stages work together. The chat UI is outside this boundary. A **regression** is a lost pass between compared runs. Reusing cases does not establish unseen-site accuracy.

Shared XPath/Resolver case names and browser/pipeline test titles describe their group and behavior, for example `targeting-save-button-by-name` and `scope-offscreen-target-is-absent`. See the [evaluation guide](docs/evaluation.md#one-evaluation-set-grouped-by-behavior) for naming and provenance.

### Example evaluation cases

These are actual cases from the shared evaluation set. Expected selectors belong to the independent grader; the model never receives them.

| Instruction                                            | Expected result                                                       | What it checks                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------- |
| “Click Save changes.”                                  | The labelled Save button, with a unique same-node XPath               | Target selection and XPath identity             |
| “Click all Approve buttons in Approvals.”              | Both buttons, including the disabled one; its readiness is blocked    | Exact target-set completeness and readiness     |
| “Click Help.” with Help off-screen                     | `not_found` in the current view                                       | Scoped absence in Resolver E2E                  |
| “Fill Notes.” with readonly Notes                      | Found target, `fill` action, blocked readiness with reason `readonly` | Action interpretation and passive state         |
| “Click Save changes in Profile.” then insert a wrapper | The saved XPath still identifies the intended button                  | Locator reuse in deterministic XPath evaluation |

See [case IDs, fixtures and metric definitions](docs/evaluation.md#example-cases-and-metrics), and [actual outcomes across the three systems](docs/research/engineering-comparison.md#case-examples).

### Basic resolver, Improved resolver and Stagehand

All three systems receive the same instruction and reset page state, but prepare their own model input:

| System            | What it uses                                                                                                                                 | What it returns                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Basic resolver    | Archived current-view capture, sanitized candidates, selection prompt and Browser verification                                               | Shared action, targets, verified XPath and passive readiness                      |
| Improved resolver | The same architecture, clearer control/context and absence rules, plus stricter current-view revalidation; selected implementation in `main` | The same resolution contract, with the changes evaluated together                 |
| Stagehand         | Stock `observe`, its own page snapshot, prompt and selector generation; cache and self-healing disabled                                      | Suggested actions and selectors, normalized and checked by the independent grader |

The [resolver comparison](docs/research/engineering-comparison.md) uses **183 shared browser cases**, the same DeepSeek V4.1 Flash/Wafer route, and one original attempt per system. Three isolated workers run concurrently. Earlier resolver code stays in saved images; the application keeps one implementation.

| System            | Correct action and targets | Target selection only |
| ----------------- | -------------------------: | --------------------: |
| Basic resolver    |            161/183 (88.0%) |       160/175 (91.4%) |
| Improved resolver |        **169/183 (92.3%)** |   **169/175 (96.6%)** |
| Stagehand         |            103/183 (56.3%) |       136/175 (77.7%) |

[![Accuracy by behavior category](docs/assets/evaluation/engineering-category-results.svg)](docs/assets/evaluation/engineering-category-results.svg)

Improved gained **15 passes and lost 7**, a net increase of **4.4 percentage points**. Scope and targeting improved most; state cases lost one net pass. The regressions remain visible and fail release checks under the no-regression rule.

The target-selection score excludes eight unsupported-instruction cases and checks exact nodes/absence without requiring the action name. Stagehand uses stock `observe` with a current-view instruction; it does not provide xpathed's readiness contract. The [report](docs/research/engineering-comparison.md) explains these boundaries and separates the full resolver score, timing cohorts and failures.

All **549 paid calls** are retained, with **$0.07312420** reported and no missing charges. These authored evaluation cases measure this setup. The [historical browser/offline report](docs/research/configuration-comparison.md) preserves the earlier collection and its separate offline results.

```sh
pnpm check                              # local checks
pnpm evaluate                           # all three categories, including paid model calls
pnpm evaluate:resolver                  # complete pipeline with controlled model responses
pnpm evaluate:xpath -- --case targeting-save-button-by-name # one XPath case, no model call
pnpm evaluate:replay RUN_DIRECTORY       # regrade saved evidence
```

Category commands accept `--case CASE_ID` and `--output DIRECTORY`. `pnpm evaluate -- --output DIRECTORY` stores each category beneath that directory. Controlled browser evaluation uses up to four isolated sessions; `--concurrency 1` selects serial timing. Live runs are serial. CI uses `evaluate:resolver` and stays provider-free. The other apps' unit and integration commands are unchanged.

The fresh `v1.0.0` establishes its baseline after ordinary CI and complete live checks, retiring the old release. Subsequent release PRs run ordinary CI and the complete live comparison against the exact images published for the current `release` commit. Once checks pass and the PR merges, that commit becomes the release and next baseline. Publication retains the tested images and evidence. Nightly monitoring tests that release without changing the running app. See [release operations](docs/releases.md).

## Read more

- [System walkthrough](docs/how-it-works.md): request flow and integration.
- [Engineering decisions](docs/engineering-journey.md): tradeoffs, quality and next steps.
- [Demo guide](docs/demo.md): present the working system.
- [Runtime](docs/runtime.md) and [resolution contract](docs/resolution.md): API and configuration reference.
- [Evaluation](docs/evaluation.md) and [releases](docs/releases.md): run, compare and deploy.

Imported-case review also binds the prepared model input after privacy sanitization. The host verifies this hash before provider inference; see the [prepared-input audit](docs/research/2026-10-03-prepared-input-audit.md).
