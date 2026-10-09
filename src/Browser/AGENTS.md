# Browser guidance

Browser owns browser processes, managed sessions/pages, retained capture objects, page streaming and input. Keep the boundary in Common records; use [README.md](../../README.md) and the source contracts for API behavior.

- Route page operations through `BrowserSessions` and its session gate. Cancelled in-flight commands invalidate their session; dispose browser connections, processes and temporary profiles together.
- Capture, resolve, verify readiness and highlight passively. Explicit execution revalidates retained nodes, consumes the capture before dispatch, and rejects stale identities or repeated requests. Never resolve an execution target again by XPath.
- Preserve complete current-view capture, native clipped geometry, scoped names and private-value exclusion. Frame/open-shadow context stays separate from XPath; each expression must uniquely identify the retained node in its own tree.
- Return sanitized XPath evidence and verify Resolver's ordered proposals against retained nodes. Construction and ranking belong in Resolver; Browser must not invent fallback expressions.
- Send screenshots only when Resolver or an API caller requests them. Lazy image requests reuse retained captures and recheck identity, viewport, geometry, names and state before and after masking. Mask detected editable/private controls without claiming inaccessible content is masked. Apply privacy rules to diagnostics too.
- Use `$xpathed-resolution-checks` for changed capture, XPath, readiness and execution behavior. Prove clipping, overlays, frames, shadow roots and action effects in a real browser when affected; geometry-only assertions are insufficient.
