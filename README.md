# xpathed

A local browser workspace for turning English instructions into verified XPath expressions for the page you are viewing.

## Current scope

The managed browser foundation ([#2](https://github.com/Mochib-Tech-Solutions/xpathed/issues/2)) is implemented. Open your own website, interact with Chromium tabs, and close all tabs when you are done. The full-page workspace keeps each tab’s chat beside the selected page; noVNC displays page content without Chromium's tabs or address bar. The workspace starts in dark mode. The header toggle switches directly between light and dark and remembers your choice.

Enter one English action command to resolve its targets in the current viewport through OpenRouter, such as “click all confirmation buttons in the list.” Press Enter to send or Ctrl+Enter for a new line. Chat uses separate sent and response messages with local timestamps. Responses show the element’s role/type and accessible name (including image alt text), followed by the interpreted action once, the verified XPath, then verification and state details, with no alternative paths. Multiple targets have separate numbered cards beneath one shared action and a compact partial-result summary. Commands mixing interactions or depending on sequential page changes are unsupported. Resolution time and cost appear together. Every found target is highlighted automatically with a thick black-and-white outline. Small targets also receive a brief locator spotlight; the outline remains after it fades. Highlights follow manual scrolling and remain during mouse movement; clicking or pressing a key in the browser, submitting a new instruction, navigation or switching tabs clears them. “All” means matching targets in the current view; fully off-screen targets are outside scope. Partially visible, disabled and covered targets remain eligible. Hover or focus the cost to see model/provider identity, token counts, input/output rates and subtotals, and OpenRouter’s reported charge separately from the estimate. Resolution covers ordinary controls in the main document and nested same-origin or cross-origin iframes. Frame results show the containing frame chain separately from the target’s document XPath. Chat separates target discovery from action readiness, names the checks that passed, and explains disabled, readonly, off-screen, pointer-blocked and incompatible controls. It keeps unknown keyboard readiness explicit without repeating generic execution disclaimers. Positive viewport intersection is required; passing passive checks are reported separately from blocked, unsupported or unknown readiness. Ordinary opaque CSS colors and geometry support color and spatial references; image pixels and complex effects remain unsupported. Two seconds is an aspirational latency target, not a cutoff: a valid slower response is still returned. Provider, transport and browser resource timeouts remain bounded, with separate late provider accounting. Each tab keeps its instructions, results, timestamps and resolution durations for the current workspace session. Navigation retains that history and marks older page results as historical. **Reset chat** clears the active tab’s draft and results without closing its page or changing other tabs. Closing a tab clears its chat; closing all tabs or reloading the app clears all local history. Sanitized diagnostic records are stored automatically in the backend, with no history or capture controls in the UI; see [backend diagnostics](docs/diagnostics.md). See the [versioned resolution contract](docs/resolution.md) for supported scope and error handling.

Unresolved responses distinguish ambiguity, missing targets, unsupported interactions, scope limits and technical failures. Ambiguous instructions ask for a name, section or position; partial results retain each target’s outcome.

Cost details fetch provider rates for the returned OpenRouter model across all request versions and cache successful rates for five minutes. Estimates use each request’s token counts; the reported charge stays separate. Missing or ambiguous provider rates remain unavailable.

## Setup and run

Install these prerequisites:

- Node **24.16.0** and pnpm **12.8.1**, as pinned in the repository. Run `corepack enable` if your Node installation includes Corepack.
- Docker with Compose **5.5.1** and Buildx. The browser requires a Docker host that supports Chromium's Linux sandbox; the [runtime guide](docs/runtime.md#sandbox-and-supported-environment) records the validated setup.

From the repository root:

```sh
pnpm run setup
pnpm dev
```

All five services run in Docker: the web app, client API, resolver, browser and PostgreSQL. A host .NET SDK is not needed to run them. Compose watches source files; Vite refreshes React and `dotnet watch` reloads the APIs. Dependency changes rebuild the affected image.

Open [localhost:8080](http://localhost:8080), enter a website address in the initial **New tab** and press Enter. The tab strip is present from the start, so opening a page keeps the address bar in place. This starts the browser and opens your website. Click, type and scroll directly in the managed page. Use the + button immediately after the tabs to add a page, or select and close existing tabs. Links and popup windows that open another page appear there, while noVNC continues to show only the active page without Chromium controls. Tabs share login state within their session. Separate localhost windows use isolated sessions with globally unique UUIDs shown in the header; closing one leaves the others running. Closing the last tab opens a blank replacement; up to eight tabs can be open. **Close all tabs** in the tab strip asks for confirmation before discarding every tab, chat and browsing state. It returns to the address field; entering a website starts a fresh session.

Setup creates an ignored `.env` with a random database password. Dependency installation also enables Git hooks for this worktree; see [commit checks and message policy](docs/ci.md#local-commit-checks). Add `OPENROUTER_API_KEY` to that file for instruction resolution; manual browsing works without a model key. Set `XPATHED_PORT` in your shell to choose another loopback port. Running `pnpm dev` again replaces the existing development runner for this checkout and Compose project, including an older attached Compose watcher. It prepares configuration, stops the previous project containers, then starts source watching. Ctrl+C stops the development services; configuration and PostgreSQL data are preserved. `pnpm docker:down` removes their containers while preserving PostgreSQL data.

For explicitly requested live evaluations, add the separate `OPENROUTER_EVAL_API_KEY` to `.env`; evaluation does not fall back to the application key stored in that file. See [evaluation setup](docs/evaluation.md) for key precedence and shared cost accounting.

The Compose project defaults to `xpathed`. Use a different `COMPOSE_PROJECT_NAME` and `XPATHED_PORT` for a separate checkout; development startup refuses containers labelled as belonging to another checkout. Unrelated Compose projects are left running.

### Production images locally

Stop development mode before switching:

```sh
pnpm docker:down
pnpm docker:up
```

This builds and starts the runtime images at the same address. Use `pnpm docker:logs` for service logs and `pnpm docker:down` to stop them. The database, browser debugging and raw VNC ports remain internal in both modes.

## How it works

| Service        | Responsibility                                                             |
| -------------- | -------------------------------------------------------------------------- |
| **Web**        | React interface and the HTTP/WebSocket entry point                         |
| **ClientApi**  | Client-facing endpoints and ownership of the EF Core/PostgreSQL connection |
| **Resolver**   | Stateless page inspection and instruction resolution                       |
| **Browser**    | Live Chromium sessions, page operations and the noVNC stream               |
| **PostgreSQL** | Internal diagnostic records, evidence and evaluation artifacts             |

The browser creates a fresh context and returns opaque session and page IDs. Navigation retains the page ID; closing the session or restarting the browser invalidates it. The client API and resolver pass these IDs to the browser service, so inspection refers to the exact page shown in the viewer. Live browser objects never leave their owning service.

Resolution asks a model to select an element from sanitized DOM context, then constructs and verifies XPath expressions in ordinary code. It reports and highlights the target; users perform browser actions manually. See the [specification](https://github.com/Mochib-Tech-Solutions/xpathed/issues/1) and [architecture decisions](docs/adr/) for the accepted boundaries.

## Working in the repository

```text
docker/                  Compose files, service Dockerfiles and runtime configuration
src/Common/              Shared request/response contracts and API error handling
src/Browser/             Controllers, session lifetime and noVNC transport
src/ClientApi/           Controllers, upstream forwarding, diagnostics and EF Core migrations
src/Resolver/            Controllers and stateless resolution service
src/Web/src/
  components/ui/         Shared shadcn/ui primitives
  features/workspace/    Browser/chat UI, API contracts and session state
  features/theme/        Theme preference and controls
  lib/                   Shared frontend helpers
docs/                    Runtime contracts, decisions and research
scripts/                 Workspace commands and CI change selection
evaluation/              Independent fixtures, case manifest, runner and grading
```

Each .NET API uses controller classes with attribute routes and constructor injection. `Program.cs` composes services and middleware. Keep one named C# type per matching file, namespaces aligned with folders, and service behavior in the owning project. `Common` contains only code shared across services. New projects belong in `Xpathed.slnx` and the affected-path rules in `scripts/ci-changes.mjs`.

The frontend uses React, strict TypeScript, Tailwind CSS and shadcn/ui. Reuse semantic theme tokens and shared controls; keep workspace state in its feature hook and clean up connections, timers and listeners in effects. Preserve accessible names, keyboard behavior and visible focus. Keep the product focused on chat and one browser page.

Every C# project inherits the .NET recommended analyzers, nullable checks, warnings as errors and shared style rules from `Directory.Build.props` and `.editorconfig`. Pinned CSharpier formats C# with a 120-column target, including positional records; native `dotnet format style` and build analyzers check the remaining style rules. Restore local tools with `dotnet tool restore`; `pnpm format` and CI use the same formatter. Frontend formatting, typed lint rules and Tailwind class sorting are configured centrally. The [repository guidance](AGENTS.md) explains how implementation work follows live issues and keeps these docs current.

### Commands

Root commands are defined in `package.json`. Host C# build and formatting commands need the .NET SDK pinned in `global.json`; `pnpm restore` installs their locked inputs alongside workspace dependencies.

| Command                                                                | Purpose                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm run setup`                                                       | Create local configuration and install locked workspace dependencies           |
| `pnpm dev`                                                             | Run all services in Docker with source watching                                |
| `pnpm build`                                                           | Build the .NET solution and production frontend                                |
| `pnpm check`                                                           | Run the repository's formatting, lint, build and validation gates              |
| `pnpm check:dotnet` / `pnpm check:web` / `pnpm check:tooling`          | Validate one part of the repository                                            |
| `pnpm lint`                                                            | Run analyzers, frontend lint and script syntax checks                          |
| `pnpm format` / `pnpm format:check`                                    | Apply or verify shared formatting                                              |
| `pnpm test`                                                            | Run the configured automated checks                                            |
| `pnpm test:persistence`                                                | Test migrations and recording against a supplied PostgreSQL test connection    |
| `pnpm diagnostics -- <command>`                                        | Inspect/export/import internal records; see [diagnostics](docs/diagnostics.md) |
| `pnpm test:resolution`                                                 | Run the explicit deterministic Docker resolution checks                        |
| `pnpm test:resolution:live`                                            | Check the actual OpenRouter route with a configured API key                    |
| `pnpm evaluate` / `pnpm evaluate:live`                                 | Run independent deterministic or explicitly paid resolution evaluation         |
| `pnpm evaluate:replay RUN_DIRECTORY`                                   | Regrade saved evaluation evidence without a browser or provider                |
| `pnpm evaluate:compare` / `pnpm evaluate:compare:replay RUN_DIRECTORY` | Compare the custom resolver with pinned Stagehand or regrade saved evidence    |
| `pnpm evaluate:qualify` / `pnpm evaluate:qualify:replay RUN_DIRECTORY` | Compare explicit model configurations and replay their qualification evidence  |
| `pnpm docker:up` / `pnpm docker:down`                                  | Start runtime images or stop project containers                                |
| `pnpm docker:build` / `pnpm docker:check`                              | Build runtime images or validate Docker definitions                            |
| `pnpm docker:logs` / `pnpm docker:status`                              | Inspect running services                                                       |
| `pnpm clean`                                                           | Remove generated .NET output and the frontend build                            |

`clean` preserves source, `.env`, installed dependencies and database volumes. Each service has its own Dockerfile under `docker/<service>/`; `docker/compose.sh` resolves paths from the repository root.

Preferred XPaths use explicit test contracts and meaningful target semantics before ordinary IDs, with live singleton same-node verification. Current-view results revalidate clipped viewport membership, including absence; changes to the captured target set require a new resolution. XPath uniqueness still covers the target's entire document. See the [selection policy](docs/resolution.md#preferred-xpath) and [research](docs/research/2026-10-01-semantic-xpath-reuse.md) for scope and reuse limits.

## CI

GitHub Actions selects affected .NET projects, Web and repository tooling from changed paths. Shared code selects its consumers; documentation-only changes skip application builds. Solution changes also build `Xpathed.slnx`. Formatting, lint, build and validation failures feed one final `check` result. The separate `Conventional commits` check validates every new commit and the PR title, including title edits.

Docker definitions have a separate validation job. A dedicated persistence job starts only an isolated PostgreSQL service and joins the aggregate `check` result. A deterministic browser job builds and starts only Browser, Resolver and the labelled fixture on relevant PRs and actual merged `main` revisions. PR/push CI does not start the full application stack or call paid providers. The aggregate verifies every selected job receipt against the checkout SHA and workflow attempt, then independently replays browser evidence; see the [CI runbook](docs/ci.md). Branch-protection availability depends on the private repository account plan; a green workflow alone does not establish enforced merge protection. The live resolution check pins DeepSeek V4.1 Flash through Wafer with reasoning disabled, a 4,096-token output cap for action lists and 512 for legacy calls. Runtime requests have no provider price filter. That narrow check makes at most two requests and reports known costs separately from unknown charges; the configured provider key limit controls spending. The explicit resolution checks start a separate `xpathed-resolution` stack on loopback port 8081 and stop its containers afterward; the live check runs Browser and Resolver without ClientApi or PostgreSQL.

The [independent evaluator](docs/evaluation.md) uses a separate `xpathed-evaluation` project with Browser, Resolver and labelled fixtures. It records every trial and separates intended-target grading from XPath validity. Deterministic runner/fixture/grader tests run in tooling CI; the complete deterministic browser suite also runs in its isolated CI job. Paid live runs and model comparisons remain explicit. `evaluate:compare` adds an isolated Stagehand adapter. `evaluate:qualify` compares pinned model configurations under a versioned correctness and latency policy, using baseline-relative release policy 7: match or exceed overall baseline correctness, report individual gains and lost passes, and report latency without using it as an acceptance gate, with no fixed accuracy percentage or two-second gate. Current-view prompt 10 distinguishes missing targets from ambiguity and incomplete enumeration, and matching controls from their surrounding scope. Qwen3.8 Flash is available as the explicit `--profile qwen` experiment. Live comparisons and dataset runs rely on the configured provider key limits, with no additional local campaign or Jev cap. Shared accounting preserves reported costs and unknown reservations separately; see the [accounting policy](docs/evaluation.md#explicit-live-dataset-pilot). Keep runs small and deliberate: one attempt per case, no automatic retries. Saved reports can be regraded without services. Experimental results never change the production default automatically.

The evaluation-only [context-planning comparison](docs/evaluation.md#context-planning-experiment) runs with `pnpm evaluate -- --context` (deterministic), or adds `--mode live` for explicit provider calls. It compares a fixed DeepInfra LLM with and without Jev-selected CSS/layout evidence, preserves all current-view candidates, and measures the same two-second latency threshold without cancelling a slower response. It does not enable Jev in the application or promote a model. The [paired report](docs/research/jev-context-comparison-report.md) retains the measured failures and outliers; the tested policy reduced no context and remains disabled.

The dataset `--profile deepseek-deepinfra` evaluates standard DeepInfra FP8 as a separate DeepSeek provider baseline. `--profile luna-azure` separately evaluates GPT-6 Luna through Azure with its completion-token cap, no reasoning and explicit prompt-cache controls. Interrupted responses retain generation IDs when supplied for bounded accounting recovery; recovered billing does not make a failed response successful. Offline dataset prompt experiments use the explicit, versioned `--prompt-variant` option described in [evaluation](docs/evaluation.md#external-datasets); they do not change production defaults. Forecasted batches use `--prepared-plan` to bind actual requests to reviewed inputs and per-case cost estimates. Results and measurement limits are recorded in the [labelled model comparison](docs/research/labelled-model-comparison-report.md), [paired prompt experiment](docs/research/labelled-prompt-comparison-report.md), [current-view baseline](docs/research/viewport-baseline-report.md) and [expanded source evaluation](docs/research/expanded-labelled-evaluation-report.md).

The offline [release verifier](docs/releases.md) seals qualified pilot/confirmation evidence against an exact source revision and checks it again using an independently retained digest. Missing, changed, expired or unqualified evidence fails verification. This does not promote a configuration or change the running application.

Private [artifact bundles](docs/releases.md#private-docker-artifact-bundles) preserve exact Browser/Resolver runtime images, tracked source and nonsecret profile settings. Bundle verification is offline; restoration loads images without starting the app. Packaging does not qualify a model or create an approved release. The explicitly dispatched **Release Qualification** workflow checks the dedicated key and durable shared accounting, evaluates exact saved images, and preserves private candidate bundles using compressed image transport. Its live mode requires fresh held-out labels before inference. **Release Promotion** explicitly selects a verified candidate; **Release Monitoring** checks the frozen approved release nightly using the evaluation key, including after original qualification evidence expires. Its approval record and verified images remain required; new promotions require fresh qualification. Local activation and rollback are explicit; drift never switches models or stops the app. See the [manual release runbook](docs/releases.md#manual-github-qualification).

## Roadmap

GitHub Issues hold the live requirements, dependencies and progress. The next capabilities are:

- [Complete release qualification and operational verification (#11)](https://github.com/Mochib-Tech-Solutions/xpathed/issues/11).
- [Enable eligible branch protection and verify actual Copilot review (#41)](https://github.com/Mochib-Tech-Solutions/xpathed/issues/41).

These links describe planned work, not available features. Hosting and presentation work are deferred. Consult the live tickets before starting a slice; research notes may describe alternatives that were not adopted.

## Reference

The [completed source baseline and provider comparison](docs/research/deepinfra-labelled-baseline-report.md) records the expanded labelled measurement and dated standard-route recommendations. It is separate from browser latency measurement and release qualification.

- [Runtime, API contracts and configuration](docs/runtime.md)
- [Independent evaluation, artifacts and replay](docs/evaluation.md)
- [Domain vocabulary](CONTEXT.md) and [architecture decisions](docs/adr/)
- [Controller and Docker conventions](docs/research/2026-09-29-controllers-and-docker-layout.md)
- [UI and repository guidance sources](docs/research/2026-09-29-ui-and-repository-guidance.md)

The first approved release is [v1.0.0](https://github.com/Mochib-Tech-Solutions/xpathed/releases/tag/v1.0.0); its [qualification and operational evidence](docs/research/2026-10-01-release-monitoring-setup.md#first-approved-release--2026-10-02) records measured correctness, retained failures and deployment limits. Release candidates use the package version (`v1.0.0-rc.1`) and publish model settings, measured qualification results and a changelog. Stable publication and approval follow the [release runbook](docs/releases.md#release-versions-and-notes).
