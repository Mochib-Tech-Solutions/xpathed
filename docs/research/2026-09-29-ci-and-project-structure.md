# CI and project structure

Reviewed 2026-09-29. These choices fit the current four .NET projects and the React client; they do not require additional architecture layers.

## CI

GitHub warns that filtering an entire required workflow by paths can leave its check pending. Job conditions can skip irrelevant work, while a final job with `always()` checks dependent results. Keep one stable `check` result and run selected app jobs behind it. Include `merge_group` for merge queue compatibility. [GitHub required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)

The repository compares a pull request against its merge base and a main push against its previous commit. Git treats renames as a removal and an addition for selection so both owners are checked. This is our implementation choice: it avoids a new action dependency and keeps the rules covered by the Node test runner. `Common` and shared .NET build settings select all .NET projects; Web changes select Web; Docker-only changes select configuration validation. Documentation-only edits skip app builds.

Use separate restore, formatting, build/analyzer, and test steps. `dotnet format` accepts a project and `--verify-no-changes`; an explicit restore permits `--no-restore`. Test projects use the owning project name, such as `tests/Browser.Tests/Browser.Tests.csproj` or `tests/Browser.IntegrationTests/Browser.IntegrationTests.csproj`. The test runner discovers these when they exist, checks their formatting, and runs `dotnet test`. No C# test project exists in this slice. [dotnet format](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-format), [dotnet test](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-test-vstest)

The pnpm setup action reads the root package manager version. Install with the checked-in lockfile, and cache the package store rather than checking dependencies into the repository. Workflow actions are pinned to commit SHAs. [pnpm CI](https://pnpm.io/continuous-integration), [GitHub workflow security](https://docs.github.com/en/actions/reference/security/secure-use)

## .NET boundaries

The initial endpoint-mapping layout is superseded by the requested controller convention. Each service keeps startup, dependency registration and the HTTP pipeline in `Program.cs`; its `Controllers/` folder contains API controllers with explicit routes. Browser/session behavior remains in its service classes. See [controllers and Docker layout](2026-09-29-controllers-and-docker-layout.md) for the current conventions and framework behavior.

`Common` is the shared library used by Browser, ClientApi and Resolver. Its `Contracts/` folder contains serialized request and response records; `Http/` contains the API exception and shared error response handling. The project name is a repository choice requested for clarity, not a .NET requirement. ClientApi-specific forwarding remains in `ClientApi/Http/`; browser-specific VNC relay remains in `Browser/Viewing/`. This keeps service implementation details out of the shared library.

Browser session lookup, capacity and serialized page operations live in `Browser/Sessions/BrowserSessions.cs`. `BrowserSessionRuntime.cs` owns one session's Chromium, display processes and cleanup. The ClientApi database context has its own `Data/` file. These are existing responsibilities separated into cohesive files, rather than additional application layers or interfaces with only one implementation. Microsoft recommends organizing growing applications by responsibility; the appropriate amount of separation depends on the application's size. [Application structure and separation of concerns](https://learn.microsoft.com/en-us/dotnet/architecture/modern-web-apps-azure/common-web-application-architectures)

Types use file-scoped namespaces such as `Xpathed.Browser.Sessions` and `Xpathed.Common.Contracts`, matching their folders and project root namespaces. Shared records each have a named file. [C# namespaces](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/namespaces/)

## Frontend boundaries

React recommends keeping only necessary state and placing shared state with its closest common owner. A custom hook is useful for a coherent external-system lifecycle. Effect cleanup must mirror setup, including development Strict Mode replay. The workspace therefore owns session state, a browser-session hook handles requests/polling, and the viewer handles the noVNC connection. Feature folders are a repository convention, not a React requirement. [Thinking in React](https://react.dev/learn/thinking-in-react), [custom hooks](https://react.dev/learn/reusing-logic-with-custom-hooks), [effects](https://react.dev/reference/react/useEffect)

Use explicit type-only imports with TypeScript's `verbatimModuleSyntax` and Tailwind's official Vite integration. Keep styling in complete utility class names and keep reusable controls separate from feature state. [TypeScript imports](https://www.typescriptlang.org/tsconfig/verbatimModuleSyntax.html), [Tailwind with Vite](https://tailwindcss.com/docs/installation/using-vite)

## Docker

Each app has its own Dockerfile under `docker/<service>/`; Compose definitions and runtime configuration live under `docker/`. The repository root remains the build context. Multi-stage builds copy published output into the runtime image; dependency manifests are copied before source to reuse restore layers. The Common source is shared by the three .NET services. This follows Docker's guidance on stages, context size, and caching. [Multi-stage builds](https://docs.docker.com/build/building/multi-stage/), [build practices](https://docs.docker.com/build/building/best-practices/)

Docker validation is independent of application builds. `docker compose config --quiet` validates merged settings; the base Compose file defines the path base for overrides. `docker buildx build --check` checks Dockerfiles without executing their build instructions. It can read registry metadata and needs a Docker builder; it does not build application images or start services. These checks cannot prove that an image runs successfully. Actual image builds and service startup remain explicit local/managed Docker operations. [Compose config](https://docs.docker.com/reference/cli/docker/compose/config/), [merging Compose files](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/), [Docker build checks](https://docs.docker.com/build/checks/)

Development uses Compose Watch to synchronize source and rebuild individual images when dependency manifests change. Vite and `dotnet watch` run inside their development containers. CI explicitly installs the tested Compose version because hosted runners can ship an older schema that rejects `initial_sync`. [Compose Watch](https://docs.docker.com/compose/how-tos/file-watch/), [Compose setup action](https://github.com/docker/setup-compose-action)

The APIs have no static assets, so development disables static-file handling in `dotnet watch` while retaining C# hot reload. This also avoids the SDK's static-asset manifest path issue on Unix. Vite handles the frontend assets. [dotnet watch options](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-watch#environment-variables), [SDK issue](https://github.com/dotnet/sdk/issues/54309)
