# xpathed

A local browser workspace for turning English instructions into verified XPath expressions for the page you are viewing.

## Current scope

The managed browser foundation ([#2](https://github.com/Mochib-Tech-Solutions/xpathed/issues/2)) is implemented. Open your own website, interact with Chromium tabs, and close all tabs when you are done. The full-page workspace keeps each tab’s chat beside the selected page; noVNC displays page content without Chromium's tabs or address bar. The theme menu offers System, Light and Dark modes and remembers your choice.

Enter one English action command to resolve its targets on the current page through OpenRouter, such as “click all confirmation buttons in the list.” Press Enter to send or Ctrl+Enter for a new line. Chat uses separate sent and response messages with local timestamps. Responses show the element’s role/type and accessible name (including image alt text), followed by the interpreted action once, the verified XPath, then verification and state details, with no alternative paths. Multiple targets have separate numbered cards beneath one shared action and a compact partial-result summary. Commands mixing interactions or depending on sequential page changes are unsupported. Resolution time and cost appear together. Every found target is highlighted automatically. Highlights follow manual scrolling and remain during mouse movement; clicking or pressing a key in the browser, submitting a new instruction, navigation or switching tabs clears them. Off-screen targets become visible when scrolled into view without resolution moving the page. Hover or focus the cost to see model/provider identity, token counts, input/output rates and subtotals, and OpenRouter’s reported charge separately from the estimate. Resolution covers ordinary controls in the main document and nested same-origin or cross-origin iframes. Frame results show the containing frame chain separately from the target’s document XPath. Chat separates target discovery from action readiness, names the checks that passed, and explains disabled, readonly, off-screen, pointer-blocked and incompatible controls. It keeps unknown keyboard readiness explicit without repeating generic execution disclaimers. Exposed visually hidden targets remain eligible; passing passive checks are reported separately from blocked, unsupported or unknown readiness. Each tab keeps its instructions, results, timestamps and resolution durations for the current workspace session. Navigation retains that history and marks older page results as historical. **Reset chat** clears the active tab’s draft and results without closing its page or changing other tabs. Closing a tab clears its chat; closing all tabs or reloading the app clears all local history. Sanitized diagnostic records are stored automatically in the backend, with no history or capture controls in the UI; see [backend diagnostics](docs/diagnostics.md). See the [versioned resolution contract](docs/resolution.md) for supported scope and error handling.

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

Open [localhost:8080](http://localhost:8080), enter a website address and press Enter. This starts the browser and opens your website. Click, type and scroll directly in the managed page. Use the + button immediately after the tabs to add a page, or select and close existing tabs. Links and popup windows that open another page appear there, while noVNC continues to show only the active page without Chromium controls. Tabs share login state within their session. Separate localhost windows use isolated sessions with globally unique UUIDs shown in the header; closing one leaves the others running. Closing the last tab opens a blank replacement; up to eight tabs can be open. **Close all tabs** in the tab strip asks for confirmation before discarding every tab, chat and browsing state. It returns to the address field; entering a website starts a fresh session.

Setup creates an ignored `.env` with a random database password. Add `OPENROUTER_API_KEY` to that file for instruction resolution; manual browsing works without a model key. Set `XPATHED_PORT` in your shell to choose another loopback port. Running `pnpm dev` again replaces the existing development runner for this checkout and Compose project, including an older attached Compose watcher. It prepares configuration, stops the previous project containers, then starts source watching. Ctrl+C stops the development services; configuration and PostgreSQL data are preserved. `pnpm docker:down` removes their containers while preserving PostgreSQL data.

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

## CI

GitHub Actions selects affected .NET projects, Web and repository tooling from changed paths. Shared code selects its consumers; documentation-only changes skip application builds. Solution changes also build `Xpathed.slnx`. Formatting, lint, build and validation failures feed one final `check` result.

Docker definitions have a separate validation job. A dedicated persistence job starts only an isolated PostgreSQL service and joins the aggregate `check` result. CI does not build application images or start the full application stack. Branch-protection availability depends on the private repository account plan; a green workflow alone does not establish enforced merge protection. The live resolution check pins DeepSeek V4.1 Flash through Wafer with reasoning disabled, a 4,096-token output cap for action lists and 512 for legacy calls. Runtime requests have no provider price filter. That narrow check makes at most two requests and checks reported cost against a one-cent total. The explicit resolution checks start a separate `xpathed-resolution` stack on loopback port 8081 and stop its containers afterward; the live check runs Browser and Resolver without ClientApi or PostgreSQL.

The [independent evaluator](docs/evaluation.md) uses a separate `xpathed-evaluation` project with Browser, Resolver and labelled fixtures. It records every trial and separates intended-target grading from XPath validity. Deterministic runner/fixture/grader tests run in tooling CI; browser evaluations and paid live runs remain explicit. `evaluate:compare` adds an isolated Stagehand adapter. `evaluate:qualify` compares pinned model configurations under a versioned correctness and latency policy, aiming for strictly under one second and requiring 95% correct, complete responses within two seconds (policy 2). Qwen3.8 Flash is available as the explicit `--profile qwen` experiment. Both live comparison paths share the initial experiment's $5 ceiling with dataset runs. Explicitly reviewed unknown charges consume their full original reservation, separately from reported provider costs; see the [budget rules](docs/evaluation.md#explicit-live-dataset-pilot). Saved reports can be regraded without services. Experimental results never change the production default automatically.

Offline dataset prompt experiments use the explicit, versioned `--prompt-variant` option described in [evaluation](docs/evaluation.md#external-datasets); they do not change production defaults. Results and measurement limits are recorded in the [labelled model comparison](docs/research/labelled-model-comparison-report.md) and [paired prompt experiment](docs/research/labelled-prompt-comparison-report.md).

## Roadmap

GitHub Issues hold the live requirements, dependencies and progress. The next capabilities are:

- [Qualify fast model configurations (#9)](https://github.com/Mochib-Tech-Solutions/xpathed/issues/9).
- [Extend verified PR/post-merge controls (#10)](https://github.com/Mochib-Tech-Solutions/xpathed/issues/10) and [add release promotion, rollback and drift monitoring (#11)](https://github.com/Mochib-Tech-Solutions/xpathed/issues/11).

These links describe planned work, not available features. Hosting and presentation work are deferred. Consult the live tickets before starting a slice; research notes may describe alternatives that were not adopted.

## Reference

- [Runtime, API contracts and configuration](docs/runtime.md)
- [Independent evaluation, artifacts and replay](docs/evaluation.md)
- [Domain vocabulary](CONTEXT.md) and [architecture decisions](docs/adr/)
- [Controller and Docker conventions](docs/research/2026-09-29-controllers-and-docker-layout.md)
- [UI and repository guidance sources](docs/research/2026-09-29-ui-and-repository-guidance.md)
