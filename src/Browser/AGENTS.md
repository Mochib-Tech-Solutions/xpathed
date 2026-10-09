# Browser guidance

This service is the bundled Playwright implementation with Chromium and Firefox of the Resolver's browser API. Keep implementation details behind the [browser integration contract](../../docs/runtime.md#browser-integration), with serializable Common records and opaque identities at the boundary.

For capture, XPath or readiness changes, read [resolution](../../docs/resolution.md) and use `$xpathed-resolution-checks`. For frame traversal, also read [ADR-0012](../../docs/adr/0012-keep-frame-context-separate-from-xpath.md).

`Sessions/BrowserSessions.cs` serializes operations through the session gate and handles cancellation of live commands. Keep new page operations on that path; a cancelled in-flight browser command cannot safely leave its page available for a later operation. `Viewing/` owns display relay behavior. `IBrowserPageDisplay` contains engine-specific window/focus control; keep capture logic shared. Firefox uses a fresh temporary profile for chrome suppression and native X11 focus events; dispose the profile, focus observer and its Matchbox window manager with the session. See [ADR-0031](../../docs/adr/0031-select-browser-type-per-session.md).

Resolve and highlight passively. Preserve scrolling, focus and form state; inspecting readiness must not click, type or trigger application handlers. Frame and open-shadow host context belong beside XPath, since each expression is evaluated within one DOM tree. Follow [ADR-0027](../../docs/adr/0027-keep-shadow-context-separate-from-xpath.md); preserve composed exposure, native clipped geometry, scoped names, private-value exclusion and retained node/root identity.

## Code Review Rules

- Flag captures or highlights accepted after page/document/capture identity changes, including tab activation and frame navigation.
- Flag geometry-only tests presented as actual browser readiness evidence. Exercise clipping, overlays and nested frames through `tests/resolution/` when those semantics change.
- Flag page evidence that bypasses capture sanitization merely because its destination is internal diagnostics.
