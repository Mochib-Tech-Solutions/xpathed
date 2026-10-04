# Local runtime

Resolver is the core API. It needs a browser service and model access for live resolution. The bundled Web/ClientApi workspace is a manual test client with session-local chat history. Evaluation runners call Resolver directly.

## Services

| Service      | Responsibility                                                                | Internal endpoint                      |
| ------------ | ----------------------------------------------------------------------------- | -------------------------------------- |
| `web`        | React chat/browser workspace, static files and HTTP/WebSocket proxy           | `:8080`; published at `127.0.0.1:8080` |
| `client-api` | Client endpoints forwarding to Browser and Resolver                           | `http://client-api:8080`               |
| `resolver`   | Stateless inspection and instruction resolution for the supplied managed page | `http://resolver:8080`                 |
| `browser`    | Playwright, live contexts/pages, display and noVNC transport                  | `http://browser:8080`                  |

Each browser session owns a Chromium process, an isolated browser context, up to eight managed pages, one Xvfb display and one loopback-only x11vnc listener. ASP.NET bridges binary WebSocket traffic directly to VNC and acknowledges normal viewer disconnects before releasing the connection; no debugging or raw VNC port is published. CDP is used internally to keep each Chromium window fullscreen and bring the active page to the front. No browser objects cross an HTTP boundary.

The resolver receives the same `pageId` as the client. It asks the browser service for an inspection without opening or navigating a page. The initial workspace shows a selected **New tab** and creates no session; tab creation and close-all controls stay disabled until a managed page exists. The tab strip and address bar retain their positions when navigation starts. Submitting the address bar creates a session at `about:blank` and immediately navigates to the supplied website. Later submissions reuse that session; a failed navigation keeps it available for retry.

The workspace defaults to dark before first paint and uses one header button to switch between light and dark. Explicit choices persist in `xpathed.theme`; an absent, legacy `system`, invalid or unreadable preference uses dark. OS theme changes do not alter the workspace. The chat reset uses an eraser beside its heading, separate from browser reload.

## Client API

Paths below are available through `web`. JSON uses camelCase.

The workspace requests one shared action across up to 16 targets in the current viewport, with independent target outcomes and a partial summary. Mixed interactions and sequential workflows are unsupported as a whole. The API has one current request and response shape. Current-view selection revalidates clipped target membership before returning found or absent results; a changed view returns `stale_capture` with a resolve-again message. Genuine absence displays “I couldn’t find that element in the current view.” Technical failures remain errors, not absence. Chat shows the shared action once, each target’s passive observations and one request-owned cost breakdown; all found targets are highlighted automatically. The [resolution contract](resolution.md) defines fields, limits and outcomes.

| Method and path                        | Request                                  | Response                                                                                      |
| -------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `POST /api/sessions`                   | Empty                                    | `{sessionId, pageId, viewPath}`                                                               |
| `GET /api/sessions/{sessionId}`        | Empty                                    | `{sessionId, activePageId, activationVersion, viewPath, pages}`; `pages` contains page states |
| `POST /api/sessions/{sessionId}/pages` | Empty                                    | Session state after adding and activating a blank tab                                         |
| `POST /api/pages/{pageId}/activate`    | Empty                                    | Session state after selecting the tab                                                         |
| `DELETE /api/pages/{pageId}`           | Empty                                    | Session state after closing the tab; closing the last creates a blank tab                     |
| `DELETE /api/sessions/{sessionId}`     | Empty                                    | `204`; repeated deletion succeeds                                                             |
| `GET /api/pages/{pageId}`              | Empty                                    | `{sessionId, pageId, documentId, url, title, blockedPopups}`                                  |
| `POST /api/pages/{pageId}/navigate`    | `{ "url": "https://example.com" }`       | Updated page state                                                                            |
| `POST /api/pages/{pageId}/highlight`   | `{documentId,captureId,actionId}`        | Revalidated found action and its sole overlay; no model call                                  |
| `POST /api/pages/{pageId}/resolve`     | `{instruction, documentId}`              | [Resolution result](resolution.md)                                                            |
| `POST /api/pages/{pageId}/inspect`     | Empty                                    | `{ "inspectedBy": "resolver", "page": { ... } }`                                              |
| `GET /view/{sessionId}`                | WebSocket upgrade with an allowed Origin | Binary RFB/noVNC stream                                                                       |
| `GET /health`                          | Empty                                    | Client API liveness                                                                           |

Navigation accepts absolute HTTP/HTTPS URLs without embedded credentials. The React address bar supplies `https://` for bare hostnames.

An inspection contains `sessionId`, `pageId`, `url`, `title`, `scrollY` and `capturedAt`. Current form values, passwords, cookies and storage contents are not captured.

The inspection endpoint remains available through the API; the workspace has no manual inspection control. Instruction resolution uses the separate resolve endpoint and displays its result in chat. Enter submits an instruction; Ctrl+Enter inserts a new line. Results show the reported total resolution time from `diagnostics.timingsMs.total` when available. This server duration excludes client network and display time. Each result also shows its estimated USD cost (or reported cost when an estimate is unavailable). Hovering or focusing the cost opens a structured breakdown of model/provider, input/output/reasoning/cached tokens, rates per million tokens, estimated input/output/request costs and the separately reported charge. Escape dismisses the details. Responses omit website metadata and repeated instructions; the shared action appears once above target labels, state details and one preferred verified XPath for each target. The workspace has no Inspect control; all found targets are highlighted automatically with an 8px black outline beneath a 4px white stroke and follow manual scrolling. Both strokes sit entirely outside the visible target bounds, with no interior tint. Outlines can extend beyond an overflow container but remain clipped by their owning document viewport. If a visible target is at most 24 CSS pixels wide or tall, its document briefly dims around clear target apertures of at least 48px. The spotlight holds for 600ms and fades over 600ms; reduced motion skips it. Every selected target in that document keeps a clear aperture, and the persistent outlines remain afterward. Hovering or focusing the current response’s XPath adds steady dimming with an aperture for that target, regardless of target size; exit removes it while retaining all outlines. This steady effect has no animation, including with reduced motion. Historical results cannot trigger it; Browser revalidates retained target identity and rejects invalidated captures. Frame highlights and spotlights stay within their owning frame. Mouse movement preserves highlights; browser clicks/keypresses, a new instruction and page/capture invalidation clear them. The chat header’s **Reset chat** opens a confirmation dialog. Cancel or Escape preserves the draft and results and returns focus to the reset button. Confirming clears only the current tab’s draft and results, preserves its browser page and other tabs, and returns focus to the composer. It is disabled during an operation. Each open tab retains its own draft and ordered result history in client memory, including timestamps and request-page metadata. Older-document or inactive results are labelled historical and never re-highlighted automatically. Tab close discards its chat; app reload and confirmed **Close all tabs** clear all chat history. The [resolution contract](resolution.md) documents accessibility-aware capture, sanitized naming, model selection, XPath validation, passive action observations, highlight and diagnostics. The prompt resolves current-view targets with bounded CSS appearance evidence. Two seconds is an evaluation latency threshold, not a total processing deadline; slower valid results are returned under the existing provider/transport timeouts and Browser resource budgets. Network delivery and client display add time; see [ADR-0020](adr/0020-treat-latency-targets-as-evaluation-metrics.md). Capture uses current-view filtering and bounded native intersection observations for nested-frame geometry; XPath selection favors stable contracts and semantic context. Found targets carry frame/document identity, an ordered containing-frame chain and optional open-shadow host context, separate from the target’s one tree-local XPath. Nested and dynamically inserted open roots are captured; zero-height hosts do not exclude visible descendants. Frame owners inside roots carry their own shadow chain. Closed roots remain unsupported. See [open-root locator context](resolution.md#open-shadow-dom-and-locator-context). Browser owns per-action passive readiness, separately from untested stability/event outcomes; each request uses one inference call.

### Chat target identity

Found targets carry optional `role` and `accessibleName` fields from Browser in every resolution contract. Chat shows type/name, XPath and verification within separate response messages and numbered multi-target cards. Empty accessible names remain explicit, including for images; older responses retain label/tag fallback. Sent/received times stay in per-tab workspace state and do not change backend request timing. See [target descriptions](resolution.md#target-descriptions-in-chat).

## Internal API

All three APIs use controller classes with explicit routes and constructor injection. `Program.cs` registers services and middleware; controllers handle HTTP contracts. Browser session operations remain in `Sessions/`, and a hosted service runs the inactivity sweep.

The browser service exposes the client lifecycle routes without the `/api` prefix. Its read-only inspection is `GET /pages/{pageId}/inspection`. It also owns the stable session stream `/view/{sessionId}`.

The resolver exposes `POST /pages/{pageId}/inspect`. It calls the browser inspection endpoint and returns the result with `inspectedBy: "resolver"`. The resolver also exposes `POST /pages/{pageId}/resolve`; Browser exposes the capture/selection operations in the [resolution contract](resolution.md). Both services provide their own `GET /health` liveness endpoint and can run without the client. Resolution uses the server-configured OpenRouter key. Resolution requests provider pricing for the reported model; successful rates are cached for five minutes per API base URL, model and provider. A cache miss has a two-second timeout, and lookup failures preserve the result and reported charge. See [cost estimates](resolution.md#cost-estimates).

## Browser integration

The browser service is the replaceable component behind Resolver's HTTP boundary. `src/Resolver/Program.cs` configures its named browser HTTP client with `BrowserUrl`; Resolver references `Common`, with no project dependency on `Browser`, Playwright or the test client. `src/Common` defines the serialized request and response records.

The core request path is:

```text
Caller → Resolver POST /pages/{pageId}/resolve
           → Browser POST /pages/{pageId}/capture
           → Model selection
           → Browser POST /pages/{pageId}/selections
       ← Resolution result
```

To integrate another browser implementation:

1. Implement the [capture and validation contract](resolution.md#capture-and-validation), including current-view eligibility, sanitized complete captures, opaque page/document/capture/frame identities, retained candidate-to-node identity, XPath uniqueness within the target document or open shadow tree, ordered frame/shadow context, readiness and highlights. Preserve error, invalidation and cancellation semantics. A URL change alone cannot adapt an arbitrary browser API.
2. Give the caller page/document IDs issued by that same browser service. The bundled client and evaluation runners also use the session/page lifecycle routes described above; the test client's noVNC viewer additionally needs `/view/{sessionId}`. Resolver itself does not use the viewer.
3. Point Resolver's `BrowserUrl` to the replacement. Point lifecycle callers at the same service. The bundled Compose configuration pins these URLs to `http://browser:8080`; replacing it requires a deployment configuration or Compose override, including the client's viewer proxy if retained.
4. Verify the API contract and run the Live-browser Resolver cases with deterministic provider fixtures before measuring live provider inference. Changes to browser capture or verification require fresh evaluation evidence. Spatial item captures may include optional `parentId` and `isRepeatedItem` fields; parent identities and repeated-item rectangles are revalidated before selection. See [spatial item context](resolution.md#spatial-item-context) for grouping, layout metadata and replacement-browser limits.

Playwright/Chromium is the only implemented and verified browser service. There is no ready-made adapter for an external runner's browser or raw HTML submission. A compatible adapter owns its live browser objects and preserves the contract; it does not require a new Resolver strategy or browser plugin registry.

## Evaluation commands

`pnpm evaluate` runs Saved-page selection, XPath construction and verification, and Live-browser Resolver in separate isolated stacks and records one summary per category. It includes paid inference and requires `OPENROUTER_EVAL_API_KEY` plus the reviewed dataset collection. Use `evaluate:model:live`, `evaluate:xpath` and `evaluate:resolver:live` to run categories independently. XPath construction and verification starts Browser and the fixture only; Saved-page selection starts Resolver and the evaluation runner only. Neither requires the test client. Live-browser Resolver uses real Chromium in both modes: `evaluate:resolver` uses deterministic provider fixtures, while `evaluate:resolver:live` uses live provider inference.

`evaluate:resolver` preserves the provider-free pipeline suite used in ordinary CI. The unit and integration commands for other apps are unchanged. See [evaluation](evaluation.md#run-and-replay) for filters, evidence and replay.

## Lifecycle

- Session disposal asks x11vnc and then Xvfb to terminate, allowing their display/shared-memory cleanup to finish before the slot is reused. Each process has a two-second grace period followed by forced termination if needed. This prevents repeated evaluation sessions from exhausting System V shared-memory segments.
- Each localhost window owns a separate workspace. Session and page identities are globally unique random UUIDs; the header displays the connected session ID. Closing one workspace does not close another. Creation allocates new opaque session and page IDs and opens a blank page in a fresh context. Up to four independent sessions can exist; each has up to eight tabs, one active page and one stable session viewer path.
- Child-frame navigation, attachment and detachment invalidate the page’s capture and highlights. Navigation changes the main document identity while retaining the managed page ID. Same-URL reloads also invalidate captures and old results. Cookies and storage remain in that session until it ends.
- New-tab links and popup windows become managed tabs in the same context, preserving opener relationships and shared cookies/storage. Newly opened tabs become active. The client tab strip controls creation, activation and closing; native browser chrome stays hidden. At the eight-tab limit, additional popups are closed and `blockedPopups` records the rejection.
- Activation brings the selected page to the front and invalidates previous captures and highlights, including when switching away and back without navigation. Capture, batch selection and action inspection reject inactive pages with `409 inactive_page`. Each page owns its own document/capture identity. The session’s `activationVersion` changes on every active-tab change so clients can detect switching away and back between polls. If separate Chromium windows both report focus, synchronization prioritizes the latest focus notification instead of dictionary enumeration order.
- Closing a tab selects a remaining tab when needed. Closing the last tab creates a blank replacement in the same session. Closing the session disposes all tabs and shared browsing state.
- The close API cancels active work and disposes the browser and display processes. The tab strip offers **Close all tabs** with a confirmation dialog. Confirming ends the current session, clears every tab and chat, and returns to the initial address field without creating a replacement session; cancelling keeps the current session.
- Closing or reloading the client makes a best-effort keepalive close request. A 15-minute inactivity sweep reclaims abandoned sessions. Connected clients poll session state to discover popup tabs, active-page changes and navigation.
- Restarting the browser service invalidates every live ID. Starting a new session creates fresh contexts and login state. The client detects expiry and enables starting again through the address field.
- Operations serialize within a session; independent sessions use separate locks and displays. Creation serializes while reserving a display slot.
- Cancellation while waiting for a session lock leaves the page intact. Cancellation during a running browser command closes that session, because Playwright does not provide safe interruption of that operation. Closing another session is unaffected.
- Navigation waits for `DOMContentLoaded` with a 20-second limit. It does not retry or claim that later application scripts have finished.

Operation errors use `{code, message, traceId}`. Controller validation returns the same envelope with `400 invalid_request` for malformed or empty JSON navigation bodies. Unknown, closed and previous-process page IDs all return `404 page_not_found`; the service keeps no unbounded tombstone collection. Capacity exhaustion returns `409 session_limit` or `409 tab_limit`, invalid URLs `400 invalid_url`, browser failures `502 browser_operation_failed`, and navigation timeouts `504 navigation_timeout`. Other unavailable/timeout upstreams remain operational errors. A disconnected caller may not receive a cancellation response.

## Configuration

### Backend and model usage limits

ClientApi and Resolver each enforce a shared fixed-window API allowance and a concurrent-request cap with the native ASP.NET Core rate limiter. Limits apply before controller work and span all callers and routes except `/health`. Requests exceeding either limit return HTTP 429 with an `ApiError` containing `request_rate_limited`, a useful message and a `Retry-After` header. ClientApi preserves an upstream `Retry-After`. There is no request queue or automatic retry. These global allowances do not depend on session IDs, IP addresses or untrusted forwarded headers; one visitor can exhaust the shared allowance. Existing Browser session and capture limits remain separate.

Resolver's singleton `ModelUsageLimits` reserves capacity immediately before `OpenRouterGateway` starts paid inference. Public resolution, diagnostic resolution and saved-page selection all use this gateway. Quota rejection returns the existing resolution error outcome with `model_usage_limited`, a retry message, zero `diagnostics.modelCalls` and no provider usage or charge. It does not select a target or become `not_found`. Admitted failures consume call allowance. A caller disconnect does not release the model slot: the provider attempt completes under its existing timeout and shutdown token, and late usage/cost retains its original accounting identity. Output remains capped at 4,096 tokens and oversized complete inputs remain explicit errors rather than truncated candidates.

All counters are local to one process and reset on restart. Fixed windows begin when their limiter is first used; the daily allowance is a 24-hour window, not a UTC calendar-day budget. Reservations count conservatively when a later allowance rejects admission. Multiple replicas have independent counters. Resolver remains stateless for page inputs and outcomes; resource counters and the pricing cache are shared operational state.

| Compose environment variable | .NET configuration              | Default |
| ---------------------------- | ------------------------------- | ------- |
| `API_REQUESTS_PER_MINUTE`    | `RateLimits:RequestsPerMinute`  | 120     |
| `API_CONCURRENT_REQUESTS`    | `RateLimits:ConcurrentRequests` | 8       |
| `MODEL_CALLS_PER_MINUTE`     | `ModelUsage:CallsPerMinute`     | 20      |
| `MODEL_CALLS_PER_DAY`        | `ModelUsage:CallsPerDay`        | 1000    |
| `MODEL_CONCURRENT_CALLS`     | `ModelUsage:ConcurrentCalls`    | 2       |

Values must be positive integers; zero is invalid rather than a protection bypass. Compose reads these variables from the ignored environment file. Standalone .NET hosts use their configuration keys, such as `ModelUsage__ConcurrentCalls`. Effective provider configuration records the model allowances without credentials. Trusted resolution-check and evaluation overlays explicitly use higher positive allowances so resource throttling cannot alter or shrink the evaluation denominator. Saved-page workers are separate processes; their aggregate spending is governed by the evaluation key and frozen plan.

A call allowance is not a dollar cap: request sizes, route prices and restarts affect spending. Set a credit limit on a dedicated OpenRouter application key, with a daily reset if desired, in [OpenRouter key settings](https://openrouter.ai/settings/keys); keep the evaluation key separate. OpenRouter rejects requests after that key's allowance is used, as described in [provider authentication and limits](https://openrouter.ai/docs/api/reference/authentication). Provider enforcement survives application restarts and multiple replicas. Reported and estimated charges remain informational and are never subtracted from a speculative local dollar budget.

### Service settings

| Setting                                              | Default / purpose                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `XPATHED_PORT`                                       | Host web port, `8080`; export before Compose                                                                              |
| `BrowserUrl`                                         | Internal browser base URL, `http://browser:8080`                                                                          |
| `ResolverUrl`                                        | Client API resolver URL, `http://resolver:8080`                                                                           |
| `OPENROUTER_API_KEY`                                 | Ignored local `.env` key used only by Resolver; manual browsing requires no key                                           |
| `OPENROUTER_EVAL_API_KEY`                            | Dedicated key for explicitly requested live provider inference in evaluation; never replaces the application key          |
| `OPENROUTER_MODEL` / `OPENROUTER_PROVIDER`           | Initial route `deepseek/deepseek-v4.1-flash` / `wafer`; see [resolution configuration](resolution.md#model-configuration) |
| `OPENROUTER_BASE_URL` / `OPENROUTER_TIMEOUT_SECONDS` | OpenRouter endpoint (default `https://openrouter.ai/api/v1/`) and request timeout in seconds (default `30`)               |
| `ViewerOrigins`                                      | Comma-separated exact allowed viewer origins; Compose includes localhost and 127.0.0.1                                    |
| `MaxSessions`                                        | Browser capacity, default 4; allowed 1–16                                                                                 |
| `XPATHED_URL`                                        | Vite API upstream destination                                                                                             |
| `XPATHED_BROWSER_URL`                                | Separate Vite viewer upstream in development                                                                              |

`pnpm dev` applies `docker/compose.dev.yaml` over `docker/compose.yaml` and runs all four services in containers, with Vite and `dotnet watch` for development. `docker/compose.sh` keeps paths and `.env` relative to the canonical repository root. Compose synchronizes source files and rebuilds images when dependency manifests change. `pnpm docker:up` uses production runtime images. Only the web port is published on loopback in either mode. Stop the previous mode with `pnpm docker:down` before switching.

Development startup serializes runners through a checkout-and-project-specific loopback control socket. A second invocation requests that the previous runner stop its watcher and project containers before releasing ownership. Startup then prepares configuration, checks Compose working-directory labels, stops any legacy attached watcher through project-scoped `down`, and starts `up --build --watch`. The runner signals its own child process group so the Docker frontend and Compose plugin stop together. It retains its Compose project and port environment for cleanup, and interrupted startup cannot authorize cleanup from an incomplete ownership check. A crashed runner releases its socket automatically; the next startup stops its remaining project containers. Neither replacement nor Ctrl+C removes `.env`. The default project is `xpathed`; separate checkouts require distinct `COMPOSE_PROJECT_NAME` and `XPATHED_PORT` values. A foreign listener on the control port or containers owned by another checkout cause startup to fail safely.

The default deployment is a local development tool. Session/page IDs are capabilities, not user authentication. Local HTTP/WebSocket origin checks prevent unrelated websites from controlling it. Browser/resolver control endpoints reject browser-originated requests; the client API checks same-origin requests, restricts hostnames to localhost/127.0.0.1 and its Compose names, and the dev proxy preserves foreign origins for rejection. Hosted delivery requires an explicit access policy and network restrictions before exposing these endpoints. The owner-selected public hosted demo and its source deployment are documented in [deployment operations](deployment.md). Only Chromium is implemented and validated; wire contracts contain no Chromium handles.

The [public hosted profile](deployment.md#public-browser-isolation) additionally filters Browser packets before startup, excludes private/VPS destinations, disables outbound IPv6 initiation and bounds container resources. It preserves DNS and the trusted local viewer relay. These restrictions apply to public hosting, not local development or trusted evaluation. The gateway validates public origins before translating the accepted origin for ClientApi/viewer contracts and supplies HTTPS/security headers on both success and denial responses. Headerless API clients are still possible; origin checks are not authentication.

## Sandbox and supported environment

Chromium runs as `pwuser` with `ChromiumSandbox = true`. The Compose service uses an init process, 1 GiB of shared memory and a pinned seccomp profile. It does not use `privileged`, `SYS_ADMIN`, host IPC, or `--no-sandbox`.

`docker/browser/seccomp.json` comes from [Playwright v1.63.0](https://raw.githubusercontent.com/microsoft/playwright/v1.63.0/utils/docker/seccomp_profile.json), under the included [Apache 2.0 license](../docker/browser/LICENSE.playwright). It adds `clone3` returning `ENOSYS` so glibc can fall back to the permitted `clone` call, following the [Moby seccomp baseline](https://github.com/moby/profiles/blob/seccomp/v0.2.4/seccomp/default.json). Namespace support must be available in the Docker host. Host AppArmor/sysctl settings were not changed for the local validation.

Validated locally on macOS Apple Silicon, Colima with native arm64/4 CPUs/8 GiB, Docker Engine 29.5.2, Compose 5.5.1 and Buildx 0.37.1. Ordinary CI builds affected apps on Ubuntu 24.04 amd64, validates Docker configuration separately, and runs deterministic Browser/Resolver evaluation in isolated containers. Release evaluation uses its separately configured runner platform and verifies saved image identities.

Pinned baseline: .NET SDK 10.0.401/runtime 10.0.12, Playwright .NET/browser image 1.63.0, Node 24.16.0, pnpm 12.8.1, React 19.3.0, Vite 8.3.1, Tailwind CSS 4.3.3 and noVNC 1.7.0. TypeScript uses the stable release supported by the pinned lint stack. Package lockfiles and image digests record exact inputs. x11vnc is installed from the base image's Ubuntu repository.

## Quality checks

The selected resolver uses one prompt/schema for browser resolution and Saved-page selection. Retired experiment runners and legacy contracts remain in Git history; see [ADR-0024](adr/0024-keep-one-resolution-implementation.md). Configuration hashes identify the exact effective settings without selecting a second implementation.

All .NET projects inherit nullable checks, the pinned `10.0-recommended` analyzer set, build/live analysis, code-style enforcement and warnings as errors from `Directory.Build.props`. `.editorconfig` defines formatting, braces, explicit accessibility, readonly fields and file-scoped namespaces. Pinned CSharpier owns C# whitespace/wrapping; native `dotnet format style` verifies semantic style. The root `pnpm format` and `pnpm format:check` commands apply the same split locally and in CI. The frontend uses strict TypeScript, React Strict Mode, ESLint with React Hooks/DOM/Refresh rules and Prettier with Tailwind class sorting. The dev proxy has a runnable same-origin HTTP/WebSocket check.

`pnpm check` performs locked restores, format/lint/type checks, controller/script/proxy tests and production builds. `pnpm test` runs frontend/tooling tests and associated C# test projects. Browser controller tests run in process without launching Chromium. `pnpm docker:build` builds the runtime images. The explicitly invoked `pnpm test:resolution` checks the resolution pipeline against controlled browser fixtures and deterministic provider responses. `pnpm test:resolution:live` verifies the direct resolver against OpenRouter with the configured key, including independent target checks and reported usage. Both create a separate `xpathed-resolution` Compose stack on loopback port 8081 and remove its containers afterward. Set `XPATHED_TEST_PORT` to change that port, or `XPATHED_ENV_FILE` to read a different ignored environment file. These commands are separate from CI and ordinary `pnpm test`. User-site browser interaction remains a manual check.

Ordinary PR/push CI runs independent, change-aware .NET, Web, tooling, Docker and deterministic-browser jobs without provider credentials. The browser job starts only Browser, Resolver and its fixture. Unit, integration, UI and deterministic locator checks keep their existing test ownership.

## Releases and deployment configuration

The `release` branch identifies the release. A trusted `main` → `release` PR runs ordinary CI and the complete comparison with live provider inference against the existing release commit. Both arms use the same reviewed cases and evaluation environment. One policy blocks every lost baseline pass; latency, costs and unavailable billing metadata are reported. Source-tree and artifact identity checks bind publication to the tested candidate.

Merging the passing PR establishes the next baseline. Publication attaches the tested Browser/Resolver images, source and evidence to a commit-named GitHub release. Deployment supplies OpenRouter configuration through Docker/environment variables: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_PROVIDER`, `OPENROUTER_BASE_URL` and `OPENROUTER_TIMEOUT_SECONDS`. The release includes neither credentials nor a deployment configuration snapshot. Live CI uses its separate `OPENROUTER_EVAL_API_KEY`; its nonsecret settings are recorded only as evaluation evidence.

Nightly monitoring resolves the current `release` commit and repeats its frozen collection with the published images. Failures retain their original evidence. It does not deploy or change the release. See [release operations](releases.md) and [ADR-0026](adr/0026-use-the-release-branch-as-the-baseline.md).
