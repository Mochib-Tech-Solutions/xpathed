# Docker topology and an embedded managed browser

Storage references below describe the earlier design. Application persistence was removed on 2026-10-03; see [ADR-0013](../adr/0013-keep-workspace-state-in-memory.md) and the [current runtime](../runtime.md).

Primary sources checked on 2026-09-29. The research below predates the accepted Q39–Q40 decisions: the resolver, client API and browser are standalone services, and the client uses noVNC. See ADR-0005 and specification issue #1. The earlier combined API/resolver recommendation below is superseded; retain the alternatives as research evidence, not implementation instructions.

## Containers follow runtime responsibilities

Docker recommends one concern per container, while explicitly allowing multiple related processes. Compose services are independently replaceable runtime units. Neither rule requires one container per source folder or .NET class library. [Docker build guidance](https://docs.docker.com/build/building/best-practices/#decouple-applications), [Compose services](https://docs.docker.com/reference/compose-file/services/)

Recommended local Compose layout:

| Service | Responsibility |
| --- | --- |
| `web` | React interface and its HTTP server. |
| `api` | ASP.NET Core endpoints, resolver, model connections, persistence, and the browser session owner. Resolver and browser integration remain separate source projects. |
| `browser` | Pinned Playwright server and Chromium runtime; optional display components if using noVNC. |
| `db` | PostgreSQL with a persistent data volume. |

The API can expose resolution as an independent HTTP contract without adding a second application API and a second resolver process. Split those processes later if separate deployment, scaling, or isolation becomes an actual requirement. This is an architectural recommendation, not a Docker restriction.

Compose provides service-name discovery on its network. Browser automation ports should remain internal; publish the local UI/API on loopback. A hosted version needs authenticated browser-view access and stricter network isolation before exposing arbitrary URL browsing. [Compose networking](https://docs.docker.com/compose/how-tos/networking/)

## One managed page, one owner

Proposed contract:

1. The API creates a fresh context and one page, returning an opaque `pageId`.
2. React uses that ID for navigation, resolution, highlighting, and user-requested interactions. The ID refers to a live browser object owned by the API; it is not a URL, browser debugging endpoint, or durable database handle.
3. The browser module keeps the ID-to-page mapping and uses one Playwright connection. Both the client endpoints and resolver call that module.
4. Navigation stays in the same managed page. Closing/restarting the context invalidates its ID. No tab picker or persistent login restoration is required.
5. Explicitly reject unsupported new-window workflows; do not silently switch the resolver to a popup. This still needs a precise popup policy when implementing the one-page constraint.

The user sees the same browser state that the resolver inspects. A second Chromium instance opened at the same URL would not satisfy that requirement. A later Stagehand comparison should use isolated evaluation sessions or an explicitly coordinated attachment, never two uncoordinated owners of the demo page.

Playwright .NET can connect to a Node-launched browser server with `ConnectAsync`; client/server major and minor versions must match. Chromium CDP connections are supported but documented as lower fidelity and Chromium-specific. Prefer the Playwright protocol for the primary .NET path, keeping CDP inside any adapter that actually requires it. [BrowserType .NET](https://playwright.dev/dotnet/docs/api/class-browsertype), [Node launchServer](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-server)

There are two distinct ownership layouts; choose one rather than combining them:

- **Existing Playwright server:** `browser` runs a small Node launcher and Chromium. `api` maintains the .NET `IPage` objects, IDs, and sole automation connection. The browser container is independently runnable, but the application session owner lives in `api`. This reuses Playwright's existing remote protocol and is the smaller initial implementation.
- **.NET browser host:** `browser` runs an ASP.NET Core host, the browser module, and Chromium. It owns every `IPage` and exposes application-level capture, validation, navigation, and interaction operations keyed by `pageId`. The resolver in `api` exchanges serialized data with it; `IPage` never crosses the boundary. This avoids a Node launcher but requires a new internal HTTP contract and error/lifecycle handling. Choose it if an independently owned browser service is itself part of the assignment's intended deliverable.

In both layouts React talks through the application boundary and never gets unrestricted Playwright/CDP access. This recommendation keeps the choice explicit; the current specification has not accepted either process topology.

## Showing the page inside React

Embedding the target URL directly in an iframe is insufficient for general websites: sites can forbid framing, and same-origin rules restrict the parent application's DOM access. Display a view of the managed browser instead. [X-Frame-Options](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Frame-Options), [Same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)

Two viable options deserve a small integration check before committing:

| Option | Existing capability | Work still needed |
| --- | --- | --- |
| Native Playwright screencast | Current .NET documentation exposes `Page.Screencast.StartAsync` with JPEG frame callbacks and viewport dimensions, introduced in v1.59. | Relay frames to React and forward mouse/keyboard input; correctly map scaled coordinates, modifiers, focus, and text composition. Handle dialogs/uploads explicitly. |
| noVNC | An embeddable JavaScript VNC client supplies graphics and keyboard/pointer interaction with an existing remote display. | Run a headed browser on Xvfb, a VNC server, and a WebSocket bridge. Embed the viewer and coordinate its input with resolution. |

Sources: [Playwright screencast](https://playwright.dev/dotnet/docs/api/class-screencast), [noVNC API](https://novnc.com/noVNC/docs/API.html), [noVNC embedding](https://novnc.com/noVNC/docs/EMBEDDING.html), [websockify](https://github.com/novnc/websockify), [x11vnc](https://github.com/LibVNC/x11vnc).

**Recommendation:** use noVNC if the demo needs general manual browser interaction immediately. It avoids building and debugging an input forwarding system. Native screencast is the smaller dependency option for a deliberately scoped page viewer, and deserves a short integration check before rejecting it; its frame API alone does not supply a complete interactive browser UI. Do not commit to a custom streaming platform. The noVNC viewer is a mature component, but the browser image still needs display setup and lifecycle checks.

Playwright mouse coordinates use main-frame viewport CSS pixels. A scaled stream therefore needs an explicit coordinate transform. The native keyboard API supplies key down/up and text insertion primitives. Stream images are for the human interface; they do not change the accepted DOM-only model input. [Mouse](https://playwright.dev/dotnet/docs/api/class-mouse), [Keyboard](https://playwright.dev/dotnet/docs/api/class-keyboard)

For noVNC, the documented `viewOnly` property prevents forwarding user input. It could temporarily lock the view during a resolution request under the stable-page assumption. This does not freeze the website's own scripts. Prefer fixed browser viewport dimensions initially and scale only the viewer. [noVNC API](https://novnc.com/noVNC/docs/API.html)

## Minimum verification before choosing the viewer

Run one integration check on the actual pinned package/image: display the page, manually type and scroll, resolve from the same `pageId`, and highlight the verified node. Check a scaled viewport and an iframe target. Confirm page close/restart invalidation and no accidental second page. Native screencast support and fidelity on the selected package are untested here; no latency or interaction-quality claim has been measured.

Playwright documents Docker remote connections and Xvfb for headed Linux execution. Its Docker guide also recommends a non-root browser user and a seccomp profile for crawling, and warns that its development image is not itself a production isolation solution for untrusted sites. Pin browser/server/client versions; do not solve launch failures by permanently disabling the browser sandbox. [Playwright Docker](https://playwright.dev/dotnet/docs/docker), [Headed CI](https://playwright.dev/dotnet/docs/ci#running-headed)
