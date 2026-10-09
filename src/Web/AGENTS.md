# Web guidance

`features/workspace/useWorkspace.ts` owns per-tab state and request lifecycle; `api.ts` mirrors the wire contract. View components must not create parallel session ownership. See [README.md](../../README.md) for product scope.

- Keep chat drafts/results in memory and associated with their managed tab. Ignore late responses for closed or changed pages; never highlight or execute historical captures.
- Show readiness only at the precision returned by the API. Unknown checks remain unknown; a passed pointer check does not prove an application effect. Use one specific red explanation for blocked targets.
- Execution needs a separate explicit user action and any required user-entered value. Screenshot sharing starts off, applies to one request, and accurately discloses what may leave the browser.
- Clean up viewer listeners/connections, acknowledge drawn frames and preserve keyboard access into and out of the browser. Bind input to the displayed page/document identity. Follow existing confirmation dialogs for destructive chat/tab controls.
- Use colocated Testing Library tests for UI behavior; live hit-testing, geometry and execution claims belong in real-browser tests.
