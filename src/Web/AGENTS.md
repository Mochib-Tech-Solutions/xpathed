# Web guidance

Read [resolution](../../docs/resolution.md) before changing action cards or readiness wording. `features/workspace/useWorkspace.ts` owns per-tab state and request lifecycle; `api.ts` mirrors the wire contract. Keep view components dependent on that state rather than adding parallel session ownership.

Display observations at the precision returned by the API. A passed pointer check describes the checked point, not successful application behavior. Unknown and untested checks stay distinguishable from passed checks.

Chat drafts and results live in the workspace session; closing a tab or reloading the app discards them. See [ADR-0013](../../docs/adr/0013-keep-workspace-state-in-memory.md).

## Code Review Rules

- Flag delayed responses that land in a different active page's chat, resurrect a closed session, or highlight a historical document.
- Flag viewer listeners/connections surviving cleanup. Preserve the keyboard path into and out of the noVNC surface.
- Verify user-visible behavior in colocated Testing Library tests; use API/browser tests for live DOM claims that jsdom cannot establish.
