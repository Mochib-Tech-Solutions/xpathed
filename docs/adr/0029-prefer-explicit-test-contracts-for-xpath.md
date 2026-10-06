# Prefer explicit test contracts for XPath

Status: Accepted, 2026-10-06.

Prefer a unique explicit target test attribute using a wildcard element anchor. If it is not unique, retain a verified typed test-attribute alternative. Before language-dependent semantics, try a unique explicit ancestor test scope with the target test attribute or, when unique within that scope, its element type. Verify both the scope's retained-node identity and the complete target expression across its document or open shadow tree. Non-HTML typed selectors include the namespace URI and local name.

This treats the explicit test scope and unique descendant type as an identity contract: a saved locator can tolerate wording, wrapper and ordinary-ID changes inside that scope. Direct test anchors also tolerate element-tag replacement; typed descendants still depend on their type. Multiple matching descendants, repeated scopes and hidden/offscreen duplicates require further disambiguation. No positional first-match shortcut conceals ambiguity.

Keep meaningful semantic/native-label fallbacks before ordinary IDs, generated-ID exclusions, privacy-aware text construction and current-request retained-node revalidation. A label replacement without an explicit test contract retains the existing changed-meaning safeguards. Translation after capture still invalidates relevant captured semantics; saved-locator reuse is a separate check.

This policy cannot establish that a third-party test attribute is stable, protect against its reassignment, or survive arbitrary future edits. The [research audit](../research/2026-10-06-unique-test-id-xpath.md) records primary sources and the motivating Pinterest structure; the [resolution contract](../resolution.md#preferred-xpath) defines the selected ranking.
