# .NET, React, and managed browser setup

Storage references below describe the earlier design. Application persistence was removed on 2026-10-03; see [ADR-0013](../adr/0013-keep-workspace-state-in-memory.md) and the [current runtime](../runtime.md).

Official sources checked on 2026-09-29. PostgreSQL and separate client API, resolver, and browser runtimes are now accepted in specification issue #1 and ADR-0005. The combined-host proposal below is historical and superseded; package/API observations still require verification during implementation.

## Supported release baseline

- .NET 10 is stable/LTS. The official download page lists SDK 10.0.401 and runtime 10.0.12, released September 8, 2026. .NET 11 is still prerelease. [Downloads](https://dotnet.microsoft.com/en-us/download/dotnet/10.0)
- EF Core 10 targets .NET 10. Use compatible stable provider packages. [EF releases](https://learn.microsoft.com/en-us/ef/core/what-is-new/)
- Npgsql's EF Core provider 10.0 supports EF Core 10 if PostgreSQL is selected. Verify current compatible patches during setup. [Npgsql release notes](https://www.npgsql.org/efcore/release-notes/10.0.html)
- React's official versions page lists 19.3, including React 19.3.0 released September 9, 2026. [React versions](https://react.dev/versions)

Pin the selected SDK and dependencies in the repository for reproducible local and CI builds; update them deliberately. A React/TypeScript SPA built with Vite is a scoped recommendation for a local control UI backed by .NET, not a universal React default. [React SPA guidance](https://react.dev/learn/build-a-react-app-from-scratch)

## Proposed runtime

Use one ASP.NET Core host with Browser and Resolver class-library projects. The browser owner manages the headed browser, contexts, and live pages. React requests session/page IDs from the API; the resolver obtains the corresponding live page from the same owner. Browser objects remain in memory; persisted run metadata cannot restore live browser objects after restart. [Playwright .NET BrowserType](https://playwright.dev/dotnet/docs/api/class-browsertype)

A future JavaScript strategy can attach via CDP if needed. CDP is Chromium-only and has lower fidelity than the Playwright protocol, so this is an integration to test rather than an assumed interchangeable connection. A dedicated persistent browser profile can preserve browser state if that becomes a requirement; do not reuse a personal default profile. [Browser connections and profiles](https://playwright.dev/dotnet/docs/api/class-browsertype)

Use short-lived EF DbContext instances per request or independent operation. Do not share a DbContext across parallel evaluation tasks or keep one attached to a browser session. [DbContext guidance](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/)

## State validation

Validate XPath uniqueness and identity within its frame, then report action-specific observed state. Click, hover, and fill have different requirements: for example hover does not require enabled state, while fill requires editability. A valid XPath is not proof that the requested interaction is currently possible or that an application event handler will produce the intended outcome. [Actionability](https://playwright.dev/dotnet/docs/actionability)

Read-only state checks avoid changing the page during resolution. Trial actions are not a safe generic substitute because action machinery can scroll or press modifier keys. Bounding boxes for child-frame elements are reported relative to the main-frame viewport; viewport eligibility must also account for clipping by scroll containers and ancestor frames. Point hit-testing is useful evidence for overlays, not a complete actionability guarantee. [Locator API](https://playwright.dev/dotnet/docs/api/class-locator), [Frames](https://playwright.dev/dotnet/docs/frames), [Hit-testing](https://developer.mozilla.org/en-US/docs/Web/API/Document/elementFromPoint)

The current locator documentation includes AI-oriented ARIA snapshots with element references and optional bounding boxes. Evaluate that native facility against the required DOM coverage before building a custom extractor; verify availability in the pinned Playwright package. [Locator API](https://playwright.dev/dotnet/docs/api/class-locator)
