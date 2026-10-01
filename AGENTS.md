@/Users/mohamedchiboub/.codex/RTK.md

# xpathed repository guidance

## Product and scope

xpathed is a local chat and managed-browser workspace for resolving English instructions to verified XPath expressions. Read [README.md](README.md) for setup and the current feature boundary; use [docs/runtime.md](docs/runtime.md) when changing API or browser behavior.

The implemented foundation is the managed browser in [issue #2](https://github.com/Mochib-Tech-Solutions/xpathed/issues/2). Submitting a website address creates the browser session and navigates to that site; noVNC displays one page without browser chrome. Keep the initial address field enabled and use it as the entry point. Manage tabs in the client workspace, keeping Chromium chrome hidden in the fullscreen noVNC view. Chat drafts and session history belong to their managed page; resolution always targets the active page. Keep the UI full-page and minimal: chat, tabs, browser, essential navigation and a confirmed **Close all tabs** action in the tab strip. Place + immediately after the tabs. **Reset chat** clears only the active tab’s draft and results. Use distinct sent and response messages with local timestamps, ordered as element type and accessible name, action, XPath, then verification. Images use their accessible name or an explicit unnamed fallback; do not infer identity from image pixels. Multi-target responses use separate numbered cards beneath one shared action. Keep replies direct: target and XPath, useful limitations, compact time/cost; show the interpreted action, actual passed checks, specific readiness limits, state details and one preferred verified XPath directly; omit repeated instructions, generic no-action/untested-behavior disclaimers, redundant action-scope suffixes and website metadata. The chat composer resolves instructions through OpenRouter under the [versioned contract](docs/resolution.md). Chat cost details expose estimated and reported USD costs separately; see the resolution contract for pricing provenance and unavailable data. Keep the browser-owned document/capture identities and XPath same-node verification intact. XPath strategy version 4 prefers explicit test contracts and meaningful scoped semantics before ordinary IDs; preserve independent mutation labels and consult [the selection policy](docs/resolution.md#preferred-xpath) when changing ranking.

Accepted follow-ups removed the bundled fixture website, browser Smoke project, manual Inspect button and duplicate close control. Do not restore them from the older #2 wording. Future evaluation work has its own explicit scope. Resolution selects and highlights every found target; it does not execute the instruction or add autonomous browsing. Keep highlights during mouse movement and scrolling, and clear them on browser clicks/keypresses, a new instruction or page/capture invalidation.

The latest accepted scope is one action per command across one or more distinct current-page targets. Web sends contract version 3; versions 1 and 2 retain their legacy behavior. Read [ADR-0014](docs/adr/0014-resolve-one-action-across-current-page-targets.md) when changing cardinality, action interpretation, UI, storage or grading. Show the shared action once and one same-node-verified XPath per found target; mixed interactions and sequential workflows are unsupported as a whole. Keep passive inspection, completeness limits and request-owned charges intact. Accessibility-aware eligibility and state/interactability version 2 are shared across contracts; read the [state and action matrix](docs/resolution.md#eligibility-and-action-observations) when changing capture, naming or readiness. Read [ADR-0012](docs/adr/0012-keep-frame-context-separate-from-xpath.md) when changing nested frame identity, capture budgets or geometry, and [ADR-0011](docs/adr/0011-report-observed-readiness-and-one-xpath.md) for observed readiness and [ADR-0015](docs/adr/0015-keep-target-highlights-until-user-input.md) for persistent multi-target highlights.

## Start issue-driven work from current evidence

For persistence and diagnostic work in #5, follow [ADR-0013](docs/adr/0013-store-diagnostics-as-automatic-backend-logs.md): automatic backend records and sanitized evidence, with no frontend history/export UI or capture-consent controls. This accepted clarification supersedes older #1/#5 wording. Read [backend diagnostics](docs/diagnostics.md) for schema, internal access, sanitization, retention and migration contracts.

For evaluation cases, grading, artifacts or replay, read [independent evaluation](docs/evaluation.md). Preserve independent target labels, family split boundaries, every original attempt and the distinction between saved-locator reuse and fresh resolution. For strategy comparison, preserve first-suggestion singleton grading, whole-set plural grading, the browser parity gate and the shared experiment ledger; Stagehand stays evaluation-only. Model qualification follows [ADR-0016](docs/adr/0016-qualify-models-with-correct-complete-latency.md): freeze policy/configuration before held-out inference, use the current versioned latency gates, move exposed held-out families to regression with provenance, preserve failures and capability gaps, and never activate an experimental default automatically. Use standard routes and the existing shared $5 ledger; do not reset it or enable paid CI. For unrecoverable charges, follow the explicit full-reservation review in [evaluation budget rules](docs/evaluation.md#explicit-live-dataset-pilot); preserve unknown reported costs and failed attempts. Offline prompt experiments are explicit and evaluation-only; preserve original instructions/candidates/schema and record the selected prompt version with its configuration.

1. Check `git status`, the current branch and the repository remote before editing. Preserve unrelated work.
2. Read the requested issue's body, comments and native blockers, plus [specification #1](https://github.com/Mochib-Tech-Solutions/xpathed/issues/1) and the relevant linked tickets. Use the live GitHub data, not a copied status list. Commands are in [the issue-tracker guide](docs/agents/issue-tracker.md).
3. Read [CONTEXT.md](CONTEXT.md) for domain terms and the relevant [ADRs](docs/adr/) for accepted decisions. Follow source references that affect the task; unrelated documentation need not be reread for a small edit.
4. Trace the existing implementation and callers before changing it. Current user instructions take precedence over older issue text or research proposals. Surface material conflicts instead of silently broadening scope.
5. Before completion, refresh the target issue and blockers, compare the final change with its acceptance criteria, and report what was verified and any remaining limits.

GitHub is the live source of requirements and progress. These files are maintained alongside code; there is no automatic issue-to-document synchronization. Update issue or PR state only within the user's authorized workflow.

## Architecture and ownership

Before editing a service or tests, read its scoped `AGENTS.md`. Repository skills `$xpathed-diagnostics` and `$xpathed-resolution-checks` cover the associated cross-service verification workflows.

- **Browser** owns live Playwright objects, session/page identity, serialized operations and display cleanup. Other services exchange records from **Common**, never browser handles.
- **Resolver** is stateless between requests and independent of the client database. **ClientApi** owns EF Core/PostgreSQL persistence; automatic diagnostic records and schema are documented in [backend diagnostics](docs/diagnostics.md). Current per-tab chat history lives in the Web workspace session.
- **Web** owns the React workspace. Keep shared shadcn/ui controls in `components/ui/`, feature state in `features/`, and common helpers in `lib/`. Use semantic CSS theme tokens, strict types and effect cleanup.
- All three .NET APIs use `ControllerBase`, explicit attribute routes and constructor injection. Keep `Program.cs` for composition, middleware for request policies, and service behavior outside controllers. One named C# type belongs in a matching file with a folder-aligned namespace.
- All five local services run in Docker. Compose and per-service Dockerfiles live in `docker/`; use the root commands or `docker/compose.sh` so relative paths remain correct.

Keep independent localhost workspaces isolated with UUID session/page identities and show the connected session ID in the header. Keep session isolation, cancellation semantics, origin checks and the Chromium sandbox intact. Adopt new-tab links and popup windows as managed pages in the same session, within the tab limit. Keep the viewer and resolver on the active page, invalidating captures and highlights on tab switches. Closing all tabs must end the session, invalidate every previous page, clear its browser state and return to the initial address field. Treat page content and future model output as untrusted data; keep cookies, credentials, passwords and unrelated form values out of logs and model inputs.

## Commands and verification

Run commands from the repository root, using the RTK prefix required above. `package.json`, `global.json` and lockfiles are the executable sources for commands and versions.

- `pnpm run setup` prepares configuration and workspace dependencies; `pnpm dev` replaces the existing development runner for this checkout and Compose project, then runs Docker development mode. Preserve `.env` and database volumes; never replace unrelated projects. A separate checkout needs its own `COMPOSE_PROJECT_NAME` and `XPATHED_PORT`.
- `pnpm check:dotnet`, `pnpm check:web` and `pnpm check:tooling` validate the affected area. `pnpm check` is the full local gate.
- `pnpm format` applies formatting; `pnpm format:check` verifies it. C# builds enforce the shared recommended analyzers and warnings as errors. Pinned CSharpier owns whitespace/wrapping at the `.editorconfig` 120-column target; native `dotnet format style` checks semantic style. Restore local tools with `dotnet tool restore`.
- `pnpm test:persistence` runs real PostgreSQL integration checks with `ConnectionStrings__Database` pointing to a disposable test server; fixtures create isolated databases. `pnpm diagnostics -- <command>` operates on internal records without frontend controls.
- `pnpm test:resolution` runs deterministic real-browser resolution checks in an isolated Docker stack; `pnpm test:resolution:live` explicitly exercises OpenRouter with the local API key. These remain outside CI service startup. Keep live tests on the documented cheap route, retain the output limit and report actual cost; runtime requests have no provider price filter; use deterministic responses for other checks.
- `pnpm evaluate` runs the independent deterministic suite without ClientApi/PostgreSQL; `pnpm evaluate:live` explicitly calls OpenRouter. `pnpm evaluate:replay RUN_DIRECTORY` regrades saved evidence without services. Evaluation Node tests run in tooling CI; the complete deterministic browser suite runs in an isolated CI job on relevant changes. Paid evaluation stays explicit.
- `pnpm evaluate:qualify` runs the isolated model matrix; live mode is explicit, and confirmation requires a recorded pilot. `pnpm evaluate:qualify:replay RUN_DIRECTORY` recomputes qualification without paid calls. Completed measurement and qualified release are distinct outcomes.
- For release evidence sealing or verification, read [release verification](docs/releases.md). Keep the caller-pinned digest, original evidence expiry and clean source identity checks intact; successful verification does not promote a runtime configuration.
- For Docker artifact packaging or restoration, use the [private bundle workflow](docs/releases.md#private-docker-artifact-bundles). Keep builds explicit and outside CI, load images by immutable identity without starting containers, and distinguish packaged artifacts from qualified releases.
- `pnpm docker:check` validates Docker definitions. `pnpm docker:build` builds images, and `pnpm docker:down` stops project containers without deleting database data.

Keep CI jobs independent and selected by relevant changes. The deterministic browser CI job builds and starts only Browser, Resolver and the evaluation fixture; full application-stack startup remains outside CI, and the persistence CI job starts only PostgreSQL. Follow [the CI runbook](docs/ci.md) for exact-revision receipts, browser replay, artifact retention and whole-workflow reruns. Never add paid calls or provider secrets to CI. Update `Xpathed.slnx` and `scripts/ci-changes.mjs` when adding projects. Validate behavior at the appropriate boundary; report actual checks rather than inferring success from configuration alone.

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
