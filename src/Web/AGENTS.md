# Web guidance

`features/workspace/useWorkspace.ts` owns per-tab state and request lifecycle; `api.ts` mirrors the wire contract. View components must not create parallel session ownership. See [README.md](../../README.md) for product scope.

- Keep chat drafts/results in memory and associated with their managed tab. Ignore late responses for closed or changed pages; never highlight or execute historical captures.
- Show readiness only at the precision returned by the API. Unknown checks remain unknown; a passed pointer check does not prove an application effect. Show verified XPath for blocked targets with one specific red explanation.
- Keep screenshot and automatic execution controls in Settings, including before the first page opens. Default to Auto images and automatic execution off; preserve each tab's choices through navigation, retries and chat reset. Only a new single ready result needing no additional value may execute automatically; enabling the setting never executes history. Manual execution collects any required value separately. Preserve one-shot capture consumption and never replay failed or uncertain actions.
- Show actual server-reported image use and complete per-call costs, never requested-image guesses or partial cost totals. Keep screenshot sharing disclosure in Settings.
- Clean up viewer listeners/connections, acknowledge drawn frames and preserve keyboard access into and out of the browser. Bind input to the displayed page/document identity. Follow existing confirmation dialogs for destructive chat/tab controls.
- Use colocated Testing Library tests for UI behavior; live hit-testing, geometry and execution claims belong in real-browser tests.
