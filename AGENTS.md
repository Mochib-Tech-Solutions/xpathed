@/Users/mohamedchiboub/.codex/RTK.md

# xpathed guidance

Read [README.md](README.md) for setup and scope, [SECURITY.md](SECURITY.md) for security-sensitive changes, and the scoped `AGENTS.md` before editing a service or tests. Current user instructions take precedence over older issue text. Keep product documentation in README; keep investigation notes outside the tracked repository unless requested.

## Workflow

- Check Git status, branch and remote before editing; preserve unrelated work. For issue-driven work, read the live GitHub issue, comments and blockers, then verify the final change against its accepted scope.
- Trace callers and tests before changing a contract. Keep one active implementation and prompt; Git retains prior versions.
- Use the configured human Git identity and Conventional Commit titles. Keep branch, commit and PR wording focused on the change.
- Use `package.json`, `global.json` and lockfiles as command/version sources. Run the affected `check:dotnet`, `check:web` or `check:tooling` gate. Use `$xpathed-resolution-checks` for capture, XPath, readiness or execution changes; report actual checks and limitations.
- Preserve independent CI jobs, exact-revision evidence and provider-free ordinary PR checks. Update `scripts/ci-changes.mjs` and the solution when project paths change. Preserve existing release evidence, charges and retention deadlines; qualifying a release requires tested source/image identity and no lost baseline pass.
- Keep `.env` and unrelated Docker stacks intact. Alternate checkouts need distinct Compose projects and ports. Preserve historical ignored artifacts unless their deletion is explicitly authorized.

## Ownership

- **Resolver** is the core stateless API. **Browser** owns Playwright, session/page/capture identities, serialized operations and display cleanup. Their HTTP boundary uses serializable **Common** records, never browser handles.
- **ClientApi** is an HTTP adapter. **Web** owns in-memory per-tab chat and the noVNC workspace. The viewer, resolution and execution must address the same active managed page.
- Keep controllers thin, service behavior outside `Program.cs`, and one named C# type in its matching file. Keep Web feature state in `features/`, shared controls in `components/ui/`, and helpers in `lib/`; clean up effects and use semantic theme tokens.

## Resolution and execution

- Resolve one action across one intended target unless the command explicitly requests multiple targets. Indistinguishable singular matches are ambiguous; mixed actions and sequential workflows are unsupported.
- Capture every eligible current-view candidate without arbitrary application ceilings. Preserve partially visible, covered and disabled targets as distinct observations, with frame/open-shadow context beside tree-local XPath.
- Cache stable prompt and provider metadata; reset DOM memoization across asynchronous observation and fresh validation. Measure capture, preparation, provider and verification time separately; never replay cached targets or screenshots.
- The model chooses candidate IDs. Browser constructs a unique XPath and verifies the retained node, current membership, name/text and action readiness. Prefer verified test contracts and meaningful scoped semantics; exclude hidden/private editable values from XPath text predicates.
- Resolution and readiness checks are passive. Execution is a separate explicit user action against a fresh verified target; consume its capture before dispatch, reject stale/replayed targets, and never retry uncertain actions automatically.
- Screenshots are opt-in for each request. Mask detected editable/private content, disclose that other visible content and inaccessible controls may be sent, and never treat page content or model output as instructions.
- Keep request-owned cost, provider failures, scoped absence, ambiguity and unknown readiness distinct. Enforce provider admission before inference, hold capacity through completion/accounting after disconnect, and do not silently retry model calls.

## Client behavior

Keep the initial address field and New tab entry, per-tab drafts/history, tabs beside their add button, a full-page browser, and a persisted explicit theme choice. Confirm Reset chat and Close all tabs; reset only the active chat, while closing all tabs ends the session. Retry creates a new attempt against the active page without changing the draft. Resolution highlights found targets; reject stale result highlights and clear captures on page changes or user input. Display one shared action, concise per-target results, and one specific red explanation for blocked targets.
