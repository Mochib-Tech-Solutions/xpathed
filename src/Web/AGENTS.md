# Web guidance

Read [resolution](../../docs/resolution.md) before changing action cards or readiness wording. `features/workspace/useWorkspace.ts` owns per-tab state and request lifecycle; `api.ts` mirrors the wire contract. Keep view components dependent on that state rather than adding parallel session ownership.

Display observations at the precision returned by the API. A passed pointer check describes the checked point, not successful application behavior. Unknown and untested checks stay distinguishable from passed checks.

Backend diagnostic logging is automatic and has no history browser, export control or capture-consent UI; see [ADR-0013](../../docs/adr/0013-store-diagnostics-as-automatic-backend-logs.md). Current-session chat behavior remains independent of durable records.

## Code Review Rules

- Flag delayed responses that land in a different active page's chat, resurrect a closed session, or highlight a historical document.
- Flag viewer listeners/connections surviving cleanup. Preserve the keyboard path into and out of the noVNC surface.
- Verify user-visible behavior in colocated Testing Library tests; use API/browser tests for live DOM claims that jsdom cannot establish.
