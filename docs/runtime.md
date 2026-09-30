# Local runtime

## Services

| Service      | Responsibility                                                                | Internal endpoint                      |
| ------------ | ----------------------------------------------------------------------------- | -------------------------------------- |
| `web`        | React chat/browser workspace, static files and HTTP/WebSocket proxy           | `:8080`; published at `127.0.0.1:8080` |
| `client-api` | Client endpoints and EF Core/PostgreSQL connection                            | `http://client-api:8080`               |
| `resolver`   | Stateless inspection and instruction resolution for the supplied managed page | `http://resolver:8080`                 |
| `browser`    | Playwright, live contexts/pages, display and noVNC transport                  | `http://browser:8080`                  |
| `db`         | PostgreSQL, named persistent volume                                           | `db:5432`                              |

Each browser session owns a Chromium process, an isolated browser context, up to eight managed pages, one Xvfb display and one loopback-only x11vnc listener. ASP.NET bridges binary WebSocket traffic directly to VNC and acknowledges normal viewer disconnects before releasing the connection; no debugging or raw VNC port is published. CDP is used internally to keep each Chromium window fullscreen and bring the active page to the front. No browser objects cross an HTTP boundary.

The resolver receives the same `pageId` as the client. It asks the browser service for an inspection without opening or navigating a page. The initial workspace creates no session. Submitting the address bar creates a session at `about:blank` and immediately navigates to the supplied website. Later submissions reuse that session; a failed navigation keeps it available for retry.

## Client API

Paths below are available through `web`. JSON uses camelCase.

The workspace sends `contractVersion:"2"` to resolve ordered current-page actions with independent outcomes and a partial summary. Direct callers that omit the version retain the single-action version-1 envelope. Both share state version 2 and interactability version 2; found targets report passing passive checks, blocked, unsupported or unknown readiness for their requested action. Chat retains one request-owned cost breakdown and automatically highlights the first found target. The [resolution contract](resolution.md) defines versions, limits and migration.

| Method and path                        | Request                                       | Response                                                                                      |
| -------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `POST /api/sessions`                   | Empty                                         | `{sessionId, pageId, viewPath}`                                                               |
| `GET /api/sessions/{sessionId}`        | Empty                                         | `{sessionId, activePageId, activationVersion, viewPath, pages}`; `pages` contains page states |
| `POST /api/sessions/{sessionId}/pages` | Empty                                         | Session state after adding and activating a blank tab                                         |
| `POST /api/pages/{pageId}/activate`    | Empty                                         | Session state after selecting the tab                                                         |
| `DELETE /api/pages/{pageId}`           | Empty                                         | Session state after closing the tab; closing the last creates a blank tab                     |
| `DELETE /api/sessions/{sessionId}`     | Empty                                         | `204`; repeated deletion succeeds                                                             |
| `GET /api/pages/{pageId}`              | Empty                                         | `{sessionId, pageId, documentId, url, title, blockedPopups}`                                  |
| `POST /api/pages/{pageId}/navigate`    | `{ "url": "https://example.com" }`            | Updated page state                                                                            |
| `POST /api/pages/{pageId}/highlight`   | `{documentId,captureId,actionId}`             | Revalidated found action and its sole overlay; no model call                                  |
| `POST /api/pages/{pageId}/resolve`     | `{instruction, documentId, contractVersion?}` | [Versioned resolution result](resolution.md); omitted version retains version 1               |
| `POST /api/pages/{pageId}/inspect`     | Empty                                         | `{ "inspectedBy": "resolver", "page": { ... } }`                                              |
| `GET /view/{sessionId}`                | WebSocket upgrade with an allowed Origin      | Binary RFB/noVNC stream                                                                       |
| `GET /health`                          | Empty                                         | Client API and database readiness; `503` when DB is unavailable                               |

Navigation accepts absolute HTTP/HTTPS URLs without embedded credentials. The React address bar supplies `https://` for bare hostnames.

An inspection contains `sessionId`, `pageId`, `url`, `title`, `scrollY` and `capturedAt`. Current form values, passwords, cookies and storage contents are not captured.

The inspection endpoint remains available through the API; the workspace has no manual inspection control. Instruction resolution uses the separate resolve endpoint and displays its result in chat. Enter submits an instruction; Ctrl+Enter inserts a new line. Results show the reported total resolution time from `diagnostics.timingsMs.total` when available. This server duration excludes client network and display time. Each result also shows its estimated USD cost (or reported cost when an estimate is unavailable). Hovering or focusing the cost opens a structured breakdown of model/provider, input/output/reasoning/cached tokens, rates per million tokens, estimated input/output/request costs and the separately reported charge. Escape dismisses the details. Responses omit website metadata and repeated instructions; target labels and XPaths lead, with the interpreted action and state details inline and a single preferred verified XPath. The workspace has no Inspect control; the first found target is highlighted automatically with a node overlay that follows manual scrolling. The chat header’s **Reset chat** clears only the current tab’s draft and results, preserves its browser page and other tabs, and returns focus to the composer. It is disabled during an operation. Each open tab retains its own draft and ordered result history in client memory, including timestamps and request-page metadata. Older-document or inactive results are labelled historical and never re-highlighted automatically. Tab close discards its chat; app reload and confirmed **Close all tabs** clear all chat history. Persistence and diagnostic exports remain separate work in #5. The [resolution contract](resolution.md) documents accessibility-aware capture, sanitized naming, model selection, XPath validation, passive action observations, highlight and diagnostics. Prompt version 6 produces bounded action lists for version 2; legacy uses prompt version 5 and its three-field schema. Capture version 4 uses bounded native intersection observations for nested-frame geometry; XPath policy version 3 favors stable contracts and semantic context. State/interactability version 2 and the same OpenRouter route remain. Found targets carry frame/document identity and an ordered chain of containing-frame XPaths, separate from the target’s one document XPath. Browser owns version-2 per-action passive readiness, separately from untested stability/event outcomes; each request uses one inference call.

## Internal API

All three APIs use controller classes with explicit routes and constructor injection. `Program.cs` registers services and middleware; controllers handle HTTP contracts. Browser session operations remain in `Sessions/`, and a hosted service runs the inactivity sweep.

The browser service exposes the client lifecycle routes without the `/api` prefix. Its read-only inspection is `GET /pages/{pageId}/inspection`. It also owns the stable session stream `/view/{sessionId}`.

The resolver exposes `POST /pages/{pageId}/inspect`. It calls the browser inspection endpoint and returns the result with `inspectedBy: "resolver"`. The resolver also exposes `POST /pages/{pageId}/resolve`; Browser exposes the capture/selection operations in the [resolution contract](resolution.md). Both services provide their own `GET /health` liveness endpoint and can run without the client or database. Resolution uses the server-configured OpenRouter key.

## Lifecycle

- Each localhost window owns a separate workspace. Session and page identities are globally unique random UUIDs; the header displays the connected session ID. Closing one workspace does not close another. Creation allocates new opaque session and page IDs and opens a blank page in a fresh context. Up to four independent sessions can exist; each has up to eight tabs, one active page and one stable session viewer path.
- Child-frame navigation, attachment and detachment invalidate the page’s capture and highlights. Navigation changes the main document identity while retaining the managed page ID. Same-URL reloads also invalidate captures and old results. Cookies and storage remain in that session until it ends.
- New-tab links and popup windows become managed tabs in the same context, preserving opener relationships and shared cookies/storage. Newly opened tabs become active. The client tab strip controls creation, activation and closing; native browser chrome stays hidden. At the eight-tab limit, additional popups are closed and `blockedPopups` records the rejection.
- Activation brings the selected page to the front and invalidates previous captures and highlights, including when switching away and back without navigation. Capture, batch selection and action inspection reject inactive pages with `409 inactive_page`. Each page owns its own document/capture identity. The session’s `activationVersion` changes on every active-tab change so clients can detect switching away and back between polls. If separate Chromium windows both report focus, synchronization prioritizes the latest focus notification instead of dictionary enumeration order.
- Closing a tab selects a remaining tab when needed. Closing the last tab creates a blank replacement in the same session. Closing the session disposes all tabs and shared browsing state.
- The close API cancels active work and disposes the browser and display processes. The tab strip offers **Close all tabs** with a confirmation dialog. Confirming ends the current session, clears every tab and chat, and returns to the initial address field without creating a replacement session; cancelling keeps the current session.
- Closing or reloading the client makes a best-effort keepalive close request. A 15-minute inactivity sweep reclaims abandoned sessions. Connected clients poll session state to discover popup tabs, active-page changes and navigation.
- Restarting the browser service invalidates every live ID. Database records cannot restore contexts or login state. The client detects expiry and enables starting again through the address field.
- Operations serialize within a session; independent sessions use separate locks and displays. Creation serializes while reserving a display slot.
- Cancellation while waiting for a session lock leaves the page intact. Cancellation during a running browser command closes that session, because Playwright does not provide safe interruption of that operation. Closing another session is unaffected.
- Navigation waits for `DOMContentLoaded` with a 20-second limit. It does not retry or claim that later application scripts have finished.

Operation errors use `{code, message, traceId}`. Controller validation returns the same envelope with `400 invalid_request` for malformed or empty JSON navigation bodies. Unknown, closed and previous-process page IDs all return `404 page_not_found`; the service keeps no unbounded tombstone collection. Capacity exhaustion returns `409 session_limit` or `409 tab_limit`, invalid URLs `400 invalid_url`, browser failures `502 browser_operation_failed`, and navigation timeouts `504 navigation_timeout`. Other unavailable/timeout upstreams remain operational errors. A disconnected caller may not receive a cancellation response.

## Configuration

| Setting                                    | Default / purpose                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `XPATHED_PORT`                             | Host web port, `8080`; export before Compose                                                                              |
| `POSTGRES_PASSWORD`                        | Generated in ignored `.env`; required by Compose                                                                          |
| `ConnectionStrings__Database`              | Client API PostgreSQL connection                                                                                          |
| `BrowserUrl`                               | Internal browser base URL, `http://browser:8080`                                                                          |
| `ResolverUrl`                              | Client API resolver URL, `http://resolver:8080`                                                                           |
| `OPENROUTER_API_KEY`                       | Ignored local `.env` key used only by Resolver; manual browsing requires no key                                           |
| `OPENROUTER_MODEL` / `OPENROUTER_PROVIDER` | Initial route `deepseek/deepseek-v4.1-flash` / `wafer`; see [resolution configuration](resolution.md#model-configuration) |
| `ViewerOrigins`                            | Comma-separated exact allowed viewer origins; Compose includes localhost and 127.0.0.1                                    |
| `MaxSessions`                              | Browser capacity, default 4; allowed 1–16                                                                                 |
| `XPATHED_URL`                              | Vite API upstream destination                                                                                             |
| `XPATHED_BROWSER_URL`                      | Separate Vite viewer upstream in development                                                                              |

`pnpm dev` applies `docker/compose.dev.yaml` over `docker/compose.yaml` and runs all five services in containers, with Vite and `dotnet watch` for development. `docker/compose.sh` keeps paths and `.env` relative to the canonical repository root. Compose synchronizes source files and rebuilds images when dependency manifests change. `pnpm docker:up` uses production runtime images. Only the web port is published on loopback in either mode. Stop the previous mode with `pnpm docker:down` before switching. Both use the same PostgreSQL volume.

Development startup serializes runners through a checkout-and-project-specific loopback control socket. A second invocation requests that the previous runner stop its watcher and project containers before releasing ownership. Startup then prepares configuration, checks Compose working-directory labels, stops any legacy attached watcher through project-scoped `down`, and starts `up --build --watch`. The runner signals its own child process group so the Docker frontend and Compose plugin stop together. It retains its Compose project and port environment for cleanup, and interrupted startup cannot authorize cleanup from an incomplete ownership check. A crashed runner releases its socket automatically; the next startup stops its remaining project containers. Neither replacement nor Ctrl+C removes `.env` or database volumes. The default project is `xpathed`; separate checkouts require distinct `COMPOSE_PROJECT_NAME` and `XPATHED_PORT` values. A foreign listener on the control port or containers owned by another checkout cause startup to fail safely.

The default deployment is a local development tool. Session/page IDs are capabilities, not user authentication. Local HTTP/WebSocket origin checks prevent unrelated websites from controlling it. Browser/resolver control endpoints reject browser-originated requests; the client API checks same-origin requests, restricts hostnames to localhost/127.0.0.1 and its Compose names, and the dev proxy preserves foreign origins for rejection. Hosted delivery requires authenticated access and network restrictions before exposing these endpoints. Only Chromium is implemented and validated; wire contracts contain no Chromium handles.

## Sandbox and supported environment

Chromium runs as `pwuser` with `ChromiumSandbox = true`. The Compose service uses an init process, 1 GiB of shared memory and a pinned seccomp profile. It does not use `privileged`, `SYS_ADMIN`, host IPC, or `--no-sandbox`.

`docker/browser/seccomp.json` comes from [Playwright v1.63.0](https://raw.githubusercontent.com/microsoft/playwright/v1.63.0/utils/docker/seccomp_profile.json), under the included [Apache 2.0 license](../docker/browser/LICENSE.playwright). It adds `clone3` returning `ENOSYS` so glibc can fall back to the permitted `clone` call, following the [Moby seccomp baseline](https://github.com/moby/profiles/blob/seccomp/v0.2.4/seccomp/default.json). Namespace support must be available in the Docker host. Host AppArmor/sysctl settings were not changed for the local validation.

Validated locally on macOS Apple Silicon, Colima with native arm64/4 CPUs/8 GiB, Docker Engine 29.5.2, Compose 5.5.1 and Buildx 0.37.1. CI builds each affected app natively on Ubuntu 24.04 amd64 and validates Docker configuration separately. It does not exercise containerized browser workflows.

Pinned baseline: .NET SDK 10.0.401/runtime 10.0.12, Playwright .NET/browser image 1.63.0, EF PostgreSQL provider 10.0.3, Node 24.16.0, pnpm 12.8.1, React 19.3.0, Vite 8.3.1, Tailwind CSS 4.3.3 and noVNC 1.7.0. TypeScript uses the stable release supported by the pinned lint stack. Package lockfiles and image digests record exact inputs. x11vnc is installed from the base image's Ubuntu repository.

## Quality checks

All .NET projects inherit nullable checks, the pinned `10.0-recommended` analyzer set, build/live analysis, code-style enforcement and warnings as errors from `Directory.Build.props`. `.editorconfig` defines formatting, braces, explicit accessibility, readonly fields and file-scoped namespaces. `dotnet format Xpathed.slnx` applies the policy; `dotnet format Xpathed.slnx --no-restore --verify-no-changes` verifies it. Both are wired into the root pnpm commands and CI. The frontend uses strict TypeScript, React Strict Mode, ESLint with React Hooks/DOM/Refresh rules and Prettier with Tailwind class sorting. The dev proxy has a runnable same-origin HTTP/WebSocket check.

`pnpm check` performs locked restores, format/lint/type checks, controller/script/proxy tests and production builds. `pnpm test` runs frontend/tooling tests and associated C# test projects. Browser controller tests run in process without launching Chromium. `pnpm docker:build` builds the runtime images. The explicitly invoked `pnpm test:resolution` checks the resolution pipeline against controlled browser fixtures and deterministic provider responses. `pnpm test:resolution:live` verifies the direct resolver against OpenRouter with the configured key, including independent target checks and reported usage. Both create a separate `xpathed-resolution` Compose stack on loopback port 8081 and remove its containers afterward while retaining the test database volume. Set `XPATHED_TEST_PORT` to change that port, or `XPATHED_ENV_FILE` to read a different ignored environment file. These commands are separate from CI and ordinary `pnpm test`. User-site browser interaction remains a manual check.

GitHub Actions runs independent, change-aware jobs for each .NET project, Web, repository tooling and Docker configuration, with read-only repository permission. Docker validation checks Compose and Dockerfile definitions; image builds and service startup are separate development/managed operations. It needs no model credentials. Branch protection, model evaluations and release qualification are later tickets; committing a workflow alone does not establish those controls.
