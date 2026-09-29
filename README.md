# xpathed

A local chat and browser workspace for resolving web elements from English instructions.

## Project status

The managed browser runtime ([#2](https://github.com/Mochib-Tech-Solutions/thunders-assignment/issues/2)) provides one interactive Chromium page per session and a reset control. noVNC shows the page without Chromium's tabs or address bar. Sessions start blank; you choose the website to open.

Natural-language commands, XPath generation and highlighting start in #3. The chat composer is disabled until that slice is implemented. The separate resolver service can inspect the live page through the API.

## Run with Docker

Requires Node 24.16.0 and Docker Engine with Compose and Buildx. The tested local host is Apple Silicon with Colima (4 CPUs, 8 GiB RAM). Only the web entry point is published, on loopback. A local .NET SDK is not needed for this mode.

```sh
npm run docker:up
```

Open [localhost:8080](http://localhost:8080), click **Open browser**, then enter your website in the address bar. You can click, type and scroll within that page. **Reset session** asks for confirmation before clearing the page, chat and browsing state and starting blank again.

Startup creates an ignored `.env` with a random database password. No model credentials are needed. Set `XPATHED_PORT` in the shell when using another port. Stop with `npm run docker:down`; PostgreSQL data remains in its named volume.

## Run in development

Install the .NET SDK specified by `global.json` and use Node 24.16.0. Docker runs PostgreSQL and the sandboxed Linux browser; React and both APIs run on the host. Dependencies are locked.

```sh
npm run setup
npm run dev
```

Open [localhost:5173](http://localhost:5173). Ctrl+C stops the local processes and preserves Docker data. When switching from Docker mode, run `npm run docker:down` first.

### Root commands

Run these from the repository root. `package.json` is the single command entry point; later slices can add commands there.

| Command | What it does |
| --- | --- |
| `npm run setup` | Create local config and install locked .NET/frontend dependencies |
| `npm run dev` | Start local React/APIs and Docker browser/PostgreSQL |
| `npm run build` | Build all .NET projects and the production frontend |
| `npm run check` | Restore, check formatting/lint/types, run local tests and build |
| `npm run lint` | Run .NET analyzers, frontend ESLint and script syntax checks |
| `npm run format` | Apply C#, frontend and configuration formatting |
| `npm run format:check` | Verify formatting without writing files |
| `npm run test:unit` | Run the small local script/proxy tests |
| `npm test` | Run the local script and frontend tooling tests |
| `npm run docker:up` | Build and start the entire Docker application |
| `npm run docker:build` | Build all runtime images |
| `npm run docker:down` | Stop the project containers; preserve PostgreSQL data |
| `npm run docker:logs` | Follow service logs |
| `npm run docker:status` | Show container status |
| `npm run clean` | Remove generated .NET output and frontend build |

`clean` preserves source, `.env`, installed frontend dependencies and database volumes. Stop local development before cleaning, then rerun `setup` to restore .NET build inputs.

CI runs formatting, lint, type checks, tooling tests, production builds and Docker builds on pull requests and pushes to `main`. No model credentials are needed.

Development ports are 5173 (React), 5080 (client API), 5081 (resolver), 5082 (browser API) and 55432 (PostgreSQL), all bound to loopback. The frontend has hot reload; restart `dev` after backend changes. The browser retains its Linux display runtime in both modes.

### C# quality policy

Every C# project, including tests and new projects under this repository, inherits `Directory.Build.props` and `.editorconfig`. The SDK's .NET 10 recommended analyzers run during builds and live analysis. Nullable checks and warnings as errors are enabled; code-style checks enforce braces, explicit accessibility, readonly fields where possible, file-scoped namespaces and consistent formatting.

`npm run format` applies `dotnet format` to the whole solution. `npm run format:check` verifies it without changing files. `npm run lint` runs the analyzers, and `npm run check` includes both gates in CI. Add new projects to `Xpathed.slnx` so solution commands include them.

### Frontend conventions

The React app lives in `src/Web` and uses strict TypeScript and Tailwind CSS through the official Vite plugin. Layout and component styles use complete utility class names; shared colors and typography live in the CSS theme. Prettier sorts Tailwind classes using that theme. Keep custom CSS for base styles and the embedded noVNC canvas.

Use small components for the chat, viewer and shared controls. Keep API contracts in `api.ts`, keep session state local to the workspace, and clean up listeners, timers and viewer connections in effects. Strict Mode exercises effect cleanup during development. ESLint checks typed code, React Hooks and DOM usage, including explicit button types. Keep native controls, accessible names, visible keyboard focus and responsive layouts when adding features.

Frontend-only commands are available with `npm --prefix src/Web run check` and `npm --prefix src/Web run build`; the root commands include them.

## Design and contracts

- [Runtime, APIs and lifecycle](docs/runtime.md)

- [Specification and accepted scope](https://github.com/Mochib-Tech-Solutions/thunders-assignment/issues/1)
- [Domain glossary](CONTEXT.md)
- [Architecture decisions](docs/adr/)
- [Research and primary sources](docs/research/)

The local system runs separate .NET client API, resolver and browser services, React/noVNC, and PostgreSQL. The browser service owns live pages; the client and resolver share serialized page identities. The client API owns the EF Core/PostgreSQL connection. History and database tables belong to #5. OpenRouter integration begins in #3.

## Reading the design

The specification and ADRs define accepted requirements. Research notes preserve alternatives considered during discovery; superseded proposals are not implementation requirements. Package versions, model availability, prices, and API support must be verified when implementing the relevant ticket.

Implementation work is tracked in GitHub Issues. Each ticket should deliver a working, testable slice and name its blockers. Evaluation uses independently labelled targets and scores target selection separately from XPath validity.
