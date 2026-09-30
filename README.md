# xpathed

A local browser workspace for turning English instructions into verified XPath expressions for the page you are viewing.

## Current scope

The managed browser foundation ([#2](https://github.com/Mochib-Tech-Solutions/xpathed/issues/2)) is implemented. Open your own website, interact with one Chromium page, and reset its session when you want to start again. The full-page workspace keeps chat beside the page; noVNC displays page content without Chromium's tabs or address bar. The theme menu offers System, Light and Dark modes and remembers your choice.

Enter an English instruction to resolve one target on the current page through OpenRouter. Press Enter to send or Ctrl+Enter for a new line. Chat shows ranked verified XPath alternatives, observed state and the reported resolution time; a browser overlay highlights the target without executing the instruction. Resolution covers ordinary controls in the main document. History is not persisted. See the [versioned resolution contract](docs/resolution.md) for supported scope and error handling.

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

Open [localhost:8080](http://localhost:8080), enter a website address and press Enter. This starts the browser and opens your website. Click, type and scroll directly in the managed page. **Reset session** asks for confirmation before discarding the current page and browsing state and opening a blank session. Additional windows are blocked so the target page stays consistent.

Setup creates an ignored `.env` with a random database password. Add `OPENROUTER_API_KEY` to that file for instruction resolution; manual browsing works without a model key. Set `XPATHED_PORT` in your shell to choose another loopback port. Ctrl+C stops the development services; `pnpm docker:down` removes their containers while preserving PostgreSQL data.

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
| **Resolver**   | Stateless page inspection and instruction resolution                        |
| **Browser**    | Live Chromium sessions, page operations and the noVNC stream               |
| **PostgreSQL** | Persistent storage for later history and configuration work                |

The browser creates a fresh context and returns opaque session and page IDs. Navigation retains the page ID; reset or browser restart invalidates it. The client API and resolver pass these IDs to the browser service, so inspection refers to the exact page shown in the viewer. Live browser objects never leave their owning service.

Resolution asks a model to select an element from sanitized DOM context, then constructs and verifies XPath expressions in ordinary code. It reports and highlights the target; users perform browser actions manually. See the [specification](https://github.com/Mochib-Tech-Solutions/xpathed/issues/1) and [architecture decisions](docs/adr/) for the accepted boundaries.

## Working in the repository

```text
docker/                  Compose files, service Dockerfiles and runtime configuration
src/Common/              Shared request/response contracts and API error handling
src/Browser/             Controllers, session lifetime and noVNC transport
src/ClientApi/           Controllers, upstream forwarding and EF Core context
src/Resolver/            Controllers and stateless resolution service
src/Web/src/
  components/ui/         Shared shadcn/ui primitives
  features/workspace/    Browser/chat UI, API contracts and session state
  features/theme/        Theme preference and controls
  lib/                   Shared frontend helpers
docs/                    Runtime contracts, decisions and research
scripts/                 Workspace commands and CI change selection
```

Each .NET API uses controller classes with attribute routes and constructor injection. `Program.cs` composes services and middleware. Keep one named C# type per matching file, namespaces aligned with folders, and service behavior in the owning project. `Common` contains only code shared across services. New projects belong in `Xpathed.slnx` and the affected-path rules in `scripts/ci-changes.mjs`.

The frontend uses React, strict TypeScript, Tailwind CSS and shadcn/ui. Reuse semantic theme tokens and shared controls; keep workspace state in its feature hook and clean up connections, timers and listeners in effects. Preserve accessible names, keyboard behavior and visible focus. Keep the product focused on chat and one browser page.

Every C# project inherits the .NET recommended analyzers, nullable checks, warnings as errors and shared style rules from `Directory.Build.props` and `.editorconfig`. Frontend formatting, typed lint rules and Tailwind class sorting are configured centrally. The [repository guidance](AGENTS.md) explains how implementation work follows live issues and keeps these docs current.

### Commands

Root commands are defined in `package.json`. Host C# build and formatting commands need the .NET SDK pinned in `global.json`; `pnpm restore` installs their locked inputs alongside workspace dependencies.

| Command                                                       | Purpose                                                              |
| ------------------------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm run setup`                                              | Create local configuration and install locked workspace dependencies |
| `pnpm dev`                                                    | Run all services in Docker with source watching                      |
| `pnpm build`                                                  | Build the .NET solution and production frontend                      |
| `pnpm check`                                                  | Run the repository's formatting, lint, build and validation gates    |
| `pnpm check:dotnet` / `pnpm check:web` / `pnpm check:tooling` | Validate one part of the repository                                  |
| `pnpm lint`                                                   | Run analyzers, frontend lint and script syntax checks                |
| `pnpm format` / `pnpm format:check`                           | Apply or verify shared formatting                                    |
| `pnpm test`                                                   | Run the configured automated checks                                  |
| `pnpm test:resolution` | Run the explicit deterministic Docker resolution checks |
| `pnpm test:resolution:live` | Check the actual OpenRouter route with a configured API key |
| `pnpm docker:up` / `pnpm docker:down`                         | Start runtime images or stop project containers                      |
| `pnpm docker:build` / `pnpm docker:check`                     | Build runtime images or validate Docker definitions                  |
| `pnpm docker:logs` / `pnpm docker:status`                     | Inspect running services                                             |
| `pnpm clean`                                                  | Remove generated .NET output and the frontend build                  |

`clean` preserves source, `.env`, installed dependencies and database volumes. Each service has its own Dockerfile under `docker/<service>/`; `docker/compose.sh` resolves paths from the repository root.

## CI

GitHub Actions selects affected .NET projects, Web and repository tooling from changed paths. Shared code selects its consumers; documentation-only changes skip application builds. Solution changes also build `Xpathed.slnx`. Formatting, lint, build and validation failures feed one final `check` result.

Docker definitions have a separate validation job. CI does not build application images or start the Docker system. The live check pins DeepSeek V4.1 Flash through Wafer with reasoning disabled, a 512-token output cap and explicit provider price ceilings. It makes at most two requests and checks reported cost against a one-cent total. The explicit resolution checks start a separate `xpathed-resolution` stack on loopback port 8081 and stop its containers afterward; the live check runs Browser and Resolver without ClientApi or PostgreSQL. Live model evaluation, release qualification and verified branch/review controls are later roadmap work.

## Roadmap

GitHub Issues hold the live requirements, dependencies and progress. The next capabilities are:

- [Expand frame handling and target-state coverage (#4)](https://github.com/Mochib-Tech-Solutions/xpathed/issues/4).
- [Persist history and export permitted diagnostics (#5)](https://github.com/Mochib-Tech-Solutions/xpathed/issues/5).
- [Build independent evaluation (#6)](https://github.com/Mochib-Tech-Solutions/xpathed/issues/6), [adapt external datasets (#7)](https://github.com/Mochib-Tech-Solutions/xpathed/issues/7), [compare Stagehand (#8)](https://github.com/Mochib-Tech-Solutions/xpathed/issues/8) and [qualify fast model configurations (#9)](https://github.com/Mochib-Tech-Solutions/xpathed/issues/9).
- [Extend verified PR/post-merge controls (#10)](https://github.com/Mochib-Tech-Solutions/xpathed/issues/10) and [add release promotion, rollback and drift monitoring (#11)](https://github.com/Mochib-Tech-Solutions/xpathed/issues/11).

These links describe planned work, not available features. Hosting and presentation work are deferred. Consult the live tickets before starting a slice; research notes may describe alternatives that were not adopted.

## Reference

- [Runtime, API contracts and configuration](docs/runtime.md)
- [Domain vocabulary](CONTEXT.md) and [architecture decisions](docs/adr/)
- [Controller and Docker conventions](docs/research/2026-09-29-controllers-and-docker-layout.md)
- [UI and repository guidance sources](docs/research/2026-09-29-ui-and-repository-guidance.md)
