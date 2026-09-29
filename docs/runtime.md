# Local runtime

## Services

| Service | Responsibility | Internal endpoint |
| --- | --- | --- |
| `web` | React chat/browser workspace, static files and HTTP/WebSocket proxy | `:8080`; published at `127.0.0.1:8080` |
| `client-api` | Client endpoints and EF Core/PostgreSQL connection | `http://client-api:8080` |
| `resolver` | Stateless inspection of the supplied managed page | `http://resolver:8080` |
| `browser` | Playwright, live contexts/pages, display and noVNC transport | `http://browser:8080` |
| `db` | PostgreSQL, named persistent volume | `db:5432` |
| `smoke` | Disposable test runner; enabled only with profile `test` | No published ports |

Each browser session owns a Chromium process, an isolated browser context, one managed page, one Xvfb display and one loopback-only x11vnc listener. ASP.NET bridges binary WebSocket traffic directly to VNC; no debugging or raw VNC port is published. CDP is used internally to put Chromium in fullscreen before the viewer connects. No browser objects cross an HTTP boundary.

The resolver receives the same `pageId` as the client. It asks the browser service for an inspection without opening or navigating a page. The controlled test page creates a new document ID on each load. A changed marker plus an unchanged document ID detects an implementation that opens another page at the same URL.

## Client API

Paths below are available through `web`. JSON uses camelCase.

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /api/sessions` | Empty | `{sessionId, pageId, viewPath}` |
| `DELETE /api/sessions/{sessionId}` | Empty | `204`; repeated deletion succeeds |
| `GET /api/pages/{pageId}` | Empty | `{sessionId, pageId, url, title, blockedPopups}` |
| `POST /api/pages/{pageId}/navigate` | `{ "url": "https://example.com" }` | Updated page state |
| `POST /api/pages/{pageId}/inspect` | Empty | `{ "inspectedBy": "resolver", "page": { ... } }` |
| `GET /view/{pageId}` | WebSocket upgrade with an allowed Origin | Binary RFB/noVNC stream |
| `GET /health` | Empty | Client API and database readiness; `503` when DB is unavailable |

Navigation accepts absolute HTTP/HTTPS URLs without embedded credentials. `xpathed:welcome` opens the controlled test page. The React address bar supplies `https://` for bare hostnames.

An inspection contains `sessionId`, `pageId`, `url`, `title`, `documentId`, `marker`, `scrollY` and `capturedAt`. `documentId` and `marker` are read only on the exact controlled fixture URL; other pages return null for both. Current form values, passwords, cookies and storage contents are not captured. The fixture deliberately uses its own marker in localStorage to test session isolation.

This endpoint establishes page sharing. It does not accept natural-language instructions or return a fabricated resolution outcome. #3 adds the target-resolution contract and displays its results in chat.

## Internal API

The browser service exposes the client lifecycle routes without the `/api` prefix. Its read-only inspection is `GET /pages/{pageId}/inspection`. It owns `/view/{pageId}` and `/fixture.html` as well.

The resolver exposes `POST /pages/{pageId}/inspect`. It calls the browser inspection endpoint and returns the result with `inspectedBy: "resolver"`. Both services provide their own `GET /health` liveness endpoint and can run without the client or database. No model integration is used in this slice.

## Lifecycle

- Creation allocates new opaque session and page IDs, opens a fresh context and loads the test page. Up to four independent sessions can exist in the service; one page is shown in each client workspace.
- Navigation changes the document while retaining the managed page ID. Cookies and storage remain in that session until it ends.
- Any additional page/window is closed. `blockedPopups` increases, the client shows a short notice, and the managed page remains unchanged.
- Close cancels active work and disposes the browser and display processes. Reset closes the old session before creating a new one, and clears the chat.
- Closing or reloading the client makes a best-effort keepalive close request. A 15-minute inactivity sweep reclaims abandoned sessions. Connected clients poll page state every two seconds.
- Restarting the browser service invalidates every live ID. Database records cannot restore contexts or login state. The client detects expiry and offers a new browser.
- Operations serialize within a session; independent sessions use separate locks and displays. Creation serializes while reserving a display slot.
- Cancellation while waiting for a session lock leaves the page intact. Cancellation during a running browser command closes that session, because Playwright does not provide safe interruption of that operation. Closing another session is unaffected.
- Navigation waits for `DOMContentLoaded` with a 20-second limit. It does not retry or claim that later application scripts have finished.

Errors use `{code, message, traceId}`. Unknown, closed and previous-process page IDs all return `404 page_not_found`; the service keeps no unbounded tombstone collection. Capacity exhaustion returns `409 session_limit`, invalid URLs `400 invalid_url`, browser failures `502 browser_operation_failed`, and navigation timeouts `504 navigation_timeout`. Other unavailable/timeout upstreams remain operational errors. A disconnected caller may not receive a cancellation response.

## Configuration

| Setting | Default / purpose |
| --- | --- |
| `XPATHED_PORT` | Host web port, `8080`; export before Compose and the smoke script |
| `POSTGRES_PASSWORD` | Generated in ignored `.env`; required by Compose |
| `ConnectionStrings__Database` | Client API PostgreSQL connection |
| `BrowserUrl` | Internal browser base URL, `http://browser:8080` |
| `ResolverUrl` | Client API resolver URL, `http://resolver:8080` |
| `ViewerOrigins` | Comma-separated exact allowed viewer origins; Compose includes localhost, 127.0.0.1 and internal `web` for smoke tests |
| `MaxSessions` | Browser capacity, default 4; allowed 1–16 |
| `FixtureUrl` | Browser-local controlled fixture URL; default `http://127.0.0.1:8080/fixture.html` |
| `XPATHED_URL` | Test runner / Vite upstream destination; not a model endpoint |
| `XPATHED_BROWSER_URL` | Optional separate Vite viewer upstream for local API development |
| `EVIDENCE_DIR` | Smoke screenshot directory |

`npm run dev` applies `compose.dev.yaml` to publish only the browser API and PostgreSQL on loopback and launches the client API, resolver and Vite locally. `npm run docker:up` runs all five services in containers. Stop the previous mode with `npm run docker:down` before switching. Both use the same PostgreSQL volume.

The default deployment is a local development tool. Session/page IDs are capabilities, not user authentication. Local HTTP/WebSocket origin checks prevent unrelated websites from controlling it. Browser/resolver control endpoints reject browser-originated requests; the client API checks same-origin requests, and the dev proxy preserves foreign origins for rejection. Hosted delivery requires authenticated access and network restrictions before exposing these endpoints. Only Chromium is implemented and validated; wire contracts contain no Chromium handles.

## Sandbox and supported environment

Chromium runs as `pwuser` with `ChromiumSandbox = true`. The Compose service uses an init process, 1 GiB of shared memory and a pinned seccomp profile. It does not use `privileged`, `SYS_ADMIN`, host IPC, or `--no-sandbox`.

`infra/browser-seccomp.json` comes from [Playwright v1.63.0](https://raw.githubusercontent.com/microsoft/playwright/v1.63.0/utils/docker/seccomp_profile.json), under the included [Apache 2.0 license](../infra/LICENSE.playwright). It adds `clone3` returning `ENOSYS` so glibc can fall back to the permitted `clone` call, following the [Moby seccomp baseline](https://github.com/moby/profiles/blob/seccomp/v0.2.4/seccomp/default.json). Namespace support must be available in the Docker host. Host AppArmor/sysctl settings were not changed for the local validation.

Validated locally on macOS Apple Silicon, Colima with native arm64/4 CPUs/8 GiB, Docker Engine 29.5.2, Compose 5.5.1 and Buildx 0.37.1. CI targets Ubuntu 24.04 amd64; its first hosted run must pass before claiming that environment is validated.

Pinned baseline: .NET SDK 10.0.401/runtime 10.0.12, Playwright .NET/browser image 1.63.0, EF PostgreSQL provider 10.0.3, Node 24.16.0, React 19.3.0, Vite 8.3.1 and noVNC 1.7.0. TypeScript uses the stable release supported by the pinned lint stack. Package lockfiles and image digests record exact inputs. x11vnc is installed from the base image's Ubuntu repository.

## Quality checks

All .NET projects inherit nullable checks, recommended .NET 10 analyzers, code-style enforcement and warnings as errors. `dotnet format` verifies C# formatting. The frontend uses strict TypeScript, ESLint with React Hooks/Refresh rules and Prettier. The dev proxy has a runnable same-origin HTTP/WebSocket check.

`npm run check` performs locked restores, format/lint/type checks, script/proxy tests and production builds. `npm test` builds the containers, exercises the real noVNC path and public APIs, then restarts the browser service and checks that old IDs are rejected. It writes screenshots only of the owned fixture. The underlying `scripts/check.sh` and `scripts/smoke.sh` remain usable in CI.

The initial GitHub Actions workflow runs on PRs and main pushes with read-only repository permission. It needs no model credentials. Smoke evidence has explicit seven-day CI retention. Branch protection, model evaluations and release qualification are later tickets; committing a workflow alone does not establish those controls.
