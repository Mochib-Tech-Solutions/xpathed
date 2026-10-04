# Revalidate replayable matching rules

Status: Accepted, 2026-10-04.

Whole-view membership and repeated-item coordinate comparisons can reject a stationary target while unrelated carousel content moves. Keep one model call and add an optional bounded matching rule to its existing response, rather than adding another inference stage or excluding animated content.

The first supported rule matches one exact sanitized label or text, a broad target kind and an optional exact named scope. Resolver requires the rule to reproduce every found selected ID and no other original candidate. Browser independently checks that original set, rescans complete supported current-view candidates and requires the same retained-node set. Fresh matching competitors, changed matching names/scopes and replacement nodes invalidate it. New nodes never reuse captured IDs. Selected-node, document/frame/shadow identity, viewport/scroll, native XPath uniqueness and fresh readiness checks remain required.

Absent, ambiguous, unsupported and mixed results retain strict comparison. So do spatial, appearance, inferred-name and other instructions the rule cannot fully express. Unknown or incomplete observations fail explicitly; neither partial enumeration nor an animation flag permits success. Highlight and spotlight revalidation retain the whole verified rule set.

The model still owns semantic interpretation. Mechanical replay establishes consistency with its declared rule, not that the rule faithfully expresses arbitrary English. Preserve unverified semantic completeness and independently labelled evaluation. The [resolution contract](../resolution.md#matching-rule-revalidation) defines the fields and limits; source-pinned historical measurements retain their original meaning.
