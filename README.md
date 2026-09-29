# xpathed

A local chat and browser workspace for resolving web elements from English instructions.

## Project status

The managed browser runtime ([#2](https://github.com/Mochib-Tech-Solutions/xpathed/issues/2)) provides one interactive Chromium page per session and a reset control. noVNC shows the page without Chromium's tabs or address bar. Sessions start blank; you choose the website to open.

Natural-language commands, XPath generation and highlighting start in #3. The chat composer is disabled until that slice is implemented. The separate resolver service can inspect the live page through the API.

## Develop locally with Docker

Install Node 24.16.0, pnpm 12.8.1 and Docker with Compose 5.5.1 and Buildx. `packageManager` pins pnpm for this workspace; `corepack enable` enables it on a Node installation that includes Corepack. A host .NET SDK is not required to run the app.

```sh
pnpm run setup
pnpm dev
```

All five services run in Docker: React, ClientApi, Resolver, Browser and PostgreSQL. Compose watches source changes; Vite refreshes React and `dotnet watch` reloads the APIs. Dependency changes rebuild the affected development image. Restore layers and package caches are reused.

Open [localhost:8080](http://localhost:8080), click **Open browser**, then enter your website in the address bar. You can click, type and scroll within that page. **Reset session** asks for confirmation before clearing the page, chat and browsing state and starting blank again.

Startup creates an ignored `.env` with a random database password. No model credentials are needed. Ctrl+C stops development containers; PostgreSQL data stays in its named volume. `pnpm docker:down` removes stopped project containers while preserving that data. Set `XPATHED_PORT` in the shell to choose another loopback port.

## Run production images locally

```sh
pnpm docker:up
```

This builds each app's runtime image and starts the same services at [localhost:8080](http://localhost:8080). Use `pnpm docker:down` before switching between development and runtime modes. Neither mode publishes the database, browser debugging or raw VNC ports.

### Root commands

Run these from the repository root. `package.json` is the single command entry point; later slices can add commands there.

| Command | What it does |
| --- | --- |
| `pnpm run setup` | Create local config and install locked workspace dependencies |
| `pnpm dev` | Start every service in Docker with source watching |
| `pnpm build` | Build all .NET projects and the production frontend |
| `pnpm check` | Restore, check formatting/lint/types, run local tests and build |
| `pnpm lint` | Run .NET analyzers, frontend ESLint and script syntax checks |
| `pnpm format` | Apply C#, frontend and configuration formatting |
| `pnpm format:check` | Verify formatting without writing files |
| `pnpm test` | Run associated C# tests when present, frontend and tooling tests |
| `pnpm docker:up` | Build and start the entire Docker application |
| `pnpm docker:build` | Build all runtime images |
| `pnpm docker:check` | Validate Compose and Dockerfiles without building app images |
| `pnpm docker:down` | Stop the project containers; preserve PostgreSQL data |
| `pnpm docker:logs` | Follow service logs |
| `pnpm docker:status` | Show container status |
| `pnpm clean` | Remove generated .NET output and frontend build |

`clean` preserves source, `.env`, installed dependencies and database volumes. Host C# build/format/check commands require the SDK pinned in `global.json`; `pnpm restore:dotnet` restores their build inputs. Use `pnpm check:dotnet`, `pnpm check:web` or `pnpm check:tooling` to check one part independently.

## CI

Each affected component has its own job and separate restore, formatting, build/analyzer and test steps:

- **Common, Browser, ClientApi and Resolver:** independent .NET matrix jobs. Shared Common or .NET build configuration changes check all four projects.
- **Solution:** locked restore and Release build when `Xpathed.slnx` or the shared CI entry points change, and on full manual runs. This validates the solution's project entries in addition to each component.
- **Web:** strict TypeScript, ESLint, Prettier, frontend tests and a production build. Web-only edits skip .NET jobs.
- **Repository tooling:** script syntax, configuration formatting and tooling tests, including the changed-file selector.
- **Docker configuration:** validates both Compose modes and Dockerfiles without building application images or starting services.

Documentation-only edits skip app builds. A final `check` job reports the combined result, including failures and cancellations, so required checks do not get stuck when other jobs are skipped. CI runs for PRs, pushes to `main`, merge queues and manual dispatches. No model credentials are needed.

C# tests belong in `tests/<Project>.*Tests/`, for example `tests/Browser.Tests/Browser.Tests.csproj`. Relevant service jobs discover them automatically. There are currently no C# test projects; the script and frontend proxy tests run today.

Only the web entry point is published, on loopback. Services communicate over the Compose network in both modes. The browser retains its sandboxed Linux display runtime.

### C# quality policy

Every C# project, including tests and new projects under this repository, inherits `Directory.Build.props` and `.editorconfig`. The SDK's .NET 10 recommended analyzers run during builds and live analysis. Nullable checks and warnings as errors are enabled; code-style checks enforce braces, explicit accessibility, readonly fields where possible, file-scoped namespaces and consistent formatting.

`pnpm format` applies `dotnet format` to the whole solution. `pnpm format:check` verifies it without changing files. `pnpm lint` runs the analyzers, and `pnpm check` includes both gates in CI. Add new projects to `Xpathed.slnx` so solution commands include them.

### Frontend conventions

The React app lives in `src/Web` and uses strict TypeScript and Tailwind CSS through the official Vite plugin. Layout and component styles use complete utility class names; shared colors and typography live in the CSS theme. Prettier sorts Tailwind classes using that theme. Keep custom CSS for base styles and the embedded noVNC canvas.

Use small components for the chat, viewer and shared controls. Keep workspace API contracts in `features/workspace/api.ts`, keep session state in `useWorkspace`, and clean up listeners, timers and viewer connections in effects. Strict Mode exercises effect cleanup during development. ESLint checks typed code, React Hooks and DOM usage, including explicit button types. Keep native controls, accessible names, visible keyboard focus and responsive layouts when adding features.

Frontend-only commands are available with `pnpm check:web` and `pnpm build:web`; the root commands include them.

## Project structure

```text
src/
  Common/
    Contracts/           Shared request and response records
    Http/                Shared API errors and error responses
  Browser/
    Endpoints/           Session, page and viewer routes
    Sessions/            Session operations and browser/display lifetime
    Viewing/             noVNC transport
  ClientApi/
    Endpoints/           Client-facing routes
    Data/                EF Core context
    Http/                Upstream request forwarding
  Resolver/
    Endpoints/           Resolver routes
  Web/src/
    components/          Shared UI controls
    features/workspace/  Workspace components, API types and session hook
```

`Common` replaces the old `Contracts` project and is referenced by all three .NET services. Service-specific behavior stays in its owning service. Each API keeps composition in `Program.cs` and route definitions in `Endpoints/`. Each app has its own Dockerfile; changing one service does not rebuild unrelated service source.

Add new C# projects to `Xpathed.slnx`, and add their affected-path rules to `scripts/ci-changes.mjs`. Keep related React components and state within their feature folder. The [research notes](docs/research/2026-09-29-ci-and-project-structure.md) explain these choices and link the official guidance.

## Design and contracts

- [Runtime, APIs and lifecycle](docs/runtime.md)

- [Specification and accepted scope](https://github.com/Mochib-Tech-Solutions/xpathed/issues/1)
- [Domain glossary](CONTEXT.md)
- [Architecture decisions](docs/adr/)
- [Research and primary sources](docs/research/)

The local system runs separate .NET client API, resolver and browser services, React/noVNC, and PostgreSQL. The browser service owns live pages; the client and resolver share serialized page identities. The client API owns the EF Core/PostgreSQL connection. History and database tables belong to #5. OpenRouter integration begins in #3.

## Reading the design

The specification and ADRs define accepted requirements. Research notes preserve alternatives considered during discovery; superseded proposals are not implementation requirements. Package versions, model availability, prices, and API support must be verified when implementing the relevant ticket.

Implementation work is tracked in GitHub Issues. Each ticket should deliver a working, testable slice and name its blockers. Evaluation uses independently labelled targets and scores target selection separately from XPath validity.
