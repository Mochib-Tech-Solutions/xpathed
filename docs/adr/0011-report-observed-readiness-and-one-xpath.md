# Report observed readiness and one verified XPath

The 2026-09-30 follow-up requests meaningful readiness, one best XPath, inline state and no manual Inspect control. Successful passive checks were previously collapsed into unknown because stability and event outcome were untested. The readiness model separates these concepts: `ready` means applicable passive readiness checks passed; `blocked`, `unsupported` and `unknown` retain their distinct meanings. Stability and event outcome remain explicit unknown observations. Historical assessments retain their original meaning in saved evidence. This supersedes the all-unknown success status in [ADR-0009](0009-observe-interactability-without-executing.md).

Browser returns the first unique same-node XPath from its preference order, rather than alternative paths. The existing `xpaths` array contains exactly one entry, preserving the existing response shape. Resolver rejects contradictory readiness and multiple-path selections. Chat displays that XPath and state directly. The model still selects candidate IDs; Browser owns locator construction and observations.

The user explicitly chose to keep the current scroll position. Highlighting follows the verified DOM node in Chromium’s overlay, including targets outside the viewport, and becomes visible when the user scrolls to the target. Resolution does not scroll, focus, reveal or execute page actions. A multi-action result automatically highlights its first found target; the internal revalidation endpoint remains available while the workspace has no Inspect control.

The highlight implementation and first-target-only behavior are superseded by [ADR-0015](0015-keep-target-highlights-until-user-input.md).
