@/Users/mohamedchiboub/.codex/RTK.md

# xpathed repository guidance

## Product and scope

xpathed is a local chat and managed-browser workspace for resolving English instructions to verified XPath expressions. Read [README.md](README.md) for setup and the current feature boundary; use [docs/runtime.md](docs/runtime.md) when changing API or browser behavior.

The implemented foundation is the managed browser in [issue #2](https://github.com/Mochib-Tech-Solutions/xpathed/issues/2). Sessions start blank, users open their own websites, and noVNC displays one page without browser chrome. Keep the UI full-page and minimal: chat, browser, essential navigation and a confirmed reset. The chat composer resolves instructions through OpenRouter under the [versioned contract](docs/resolution.md). Keep the browser-owned document/capture identities and XPath same-node verification intact.

Accepted follow-ups removed the bundled fixture website, browser Smoke project, manual Inspect button and duplicate close control. Do not restore them from the older #2 wording. Future evaluation work has its own explicit scope. Resolution selects and highlights a target; it does not execute the instruction or add autonomous browsing.

## Start issue-driven work from current evidence

1. Check `git status`, the current branch and the repository remote before editing. Preserve unrelated work.
2. Read the requested issue's body, comments and native blockers, plus [specification #1](https://github.com/Mochib-Tech-Solutions/xpathed/issues/1) and the relevant linked tickets. Use the live GitHub data, not a copied status list. Commands are in [the issue-tracker guide](docs/agents/issue-tracker.md).
3. Read [CONTEXT.md](CONTEXT.md) for domain terms and the relevant [ADRs](docs/adr/) for accepted decisions. Follow source references that affect the task; unrelated documentation need not be reread for a small edit.
4. Trace the existing implementation and callers before changing it. Current user instructions take precedence over older issue text or research proposals. Surface material conflicts instead of silently broadening scope.
5. Before completion, refresh the target issue and blockers, compare the final change with its acceptance criteria, and report what was verified and any remaining limits.

GitHub is the live source of requirements and progress. These files are maintained alongside code; there is no automatic issue-to-document synchronization. Update issue or PR state only within the user's authorized workflow.

## Architecture and ownership

- **Browser** owns live Playwright objects, session/page identity, serialized operations and display cleanup. Other services exchange records from **Common**, never browser handles.
- **Resolver** is stateless between requests and independent of the client database. **ClientApi** owns EF Core/PostgreSQL persistence; history and schema work begins in #5.
- **Web** owns the React workspace. Keep shared shadcn/ui controls in `components/ui/`, feature state in `features/`, and common helpers in `lib/`. Use semantic CSS theme tokens, strict types and effect cleanup.
- All three .NET APIs use `ControllerBase`, explicit attribute routes and constructor injection. Keep `Program.cs` for composition, middleware for request policies, and service behavior outside controllers. One named C# type belongs in a matching file with a folder-aligned namespace.
- All five local services run in Docker. Compose and per-service Dockerfiles live in `docker/`; use the root commands or `docker/compose.sh` so relative paths remain correct.

Keep session isolation, popup blocking, cancellation semantics, origin checks and the Chromium sandbox intact. Reset must invalidate the previous page and clear its browser state. Treat page content and future model output as untrusted data; keep cookies, credentials, passwords and unrelated form values out of logs and model inputs.

## Commands and verification

Run commands from the repository root, using the RTK prefix required above. `package.json`, `global.json` and lockfiles are the executable sources for commands and versions.

- `pnpm run setup` prepares configuration and workspace dependencies; `pnpm dev` runs Docker development mode.
- `pnpm check:dotnet`, `pnpm check:web` and `pnpm check:tooling` validate the affected area. `pnpm check` is the full local gate.
- `pnpm format` applies formatting; `pnpm format:check` verifies it. C# builds enforce the shared recommended analyzers and warnings as errors.
- `pnpm test:resolution` runs deterministic real-browser resolution checks in an isolated Docker stack; `pnpm test:resolution:live` explicitly exercises OpenRouter with the local API key. These remain outside CI service startup.
- `pnpm docker:check` validates Docker definitions. `pnpm docker:build` builds images, and `pnpm docker:down` stops project containers without deleting database data.

Keep CI jobs independent and selected by relevant changes. Docker image builds and service startup remain explicit operations outside CI. Update `Xpathed.slnx` and `scripts/ci-changes.mjs` when adding projects. Validate behavior at the appropriate boundary; report actual checks rather than inferring success from configuration alone.

## Keep the guide current

When scope, commands, architecture or conventions change, update `README.md` and this file in the same change. Update `docs/runtime.md` for API/configuration/lifecycle changes, `CONTEXT.md` for domain terms, and an ADR for consequential accepted trade-offs. Remove stale instructions instead of accumulating contradictory history. Keep future work linked to its live issue; do not maintain a duplicate issue-status table or document test counts/inventories.

Research notes record dated evidence and alternatives, not automatic requirements. Verify version-sensitive API/package/model claims from official sources before relying on them. Keep commit, branch and PR wording focused on the change and use the configured human Git identity.

## Code Review Rules

- Check the requested issue and latest accepted scope; flag accidental feature expansion or claims that future roadmap items already work.
- Flag changes that let the viewer and resolver address different pages, preserve an invalidated session, bypass input/origin checks or weaken the browser sandbox.
- Keep shared contracts serializable and service dependencies within their documented ownership.
- Check that docs and affected CI selection match changed commands or project paths. Leave formatting and lint enforcement to configured tools.

## Repository conventions

- **Issue tracker:** GitHub Issues; see [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).
- **Triage labels:** preserve the five roles in [docs/agents/triage-labels.md](docs/agents/triage-labels.md).
- **Domain docs:** one root context and `docs/adr/`; see [docs/agents/domain.md](docs/agents/domain.md).
