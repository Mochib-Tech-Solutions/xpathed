# Browser guidance

This service is the bundled Playwright/Chromium implementation of the Resolver's browser API. Keep implementation details behind the [browser integration contract](../../docs/runtime.md#browser-integration), with serializable Common records and opaque identities at the boundary.

For capture, XPath or readiness changes, read [resolution](../../docs/resolution.md) and use `$xpathed-resolution-checks`. For frame traversal, also read [ADR-0012](../../docs/adr/0012-keep-frame-context-separate-from-xpath.md).

`Sessions/BrowserSessions.cs` serializes operations through the session gate and handles cancellation of live commands. Keep new page operations on that path; a cancelled in-flight browser command cannot safely leave its page available for a later operation. `Viewing/` owns display relay behavior.

Resolve and highlight passively. Preserve scrolling, focus and form state; inspecting readiness must not click, type or trigger application handlers. Frame context belongs beside the XPath, since an XPath is evaluated within one document.

## Code Review Rules

- Flag captures or highlights accepted after page/document/capture identity changes, including tab activation and frame navigation.
- Flag geometry-only tests presented as actual browser readiness evidence. Exercise clipping, overlays and nested frames through `tests/resolution/` when those semantics change.
- Flag page evidence that bypasses capture sanitization merely because its destination is internal diagnostics.
