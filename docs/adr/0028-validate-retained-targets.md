# Validate retained targets

Status: Accepted, 2026-10-04.

Keep one model call and verify returned targets instead of replaying model-declared matching rules or comparing the whole view. Each selected live node must retain its document/root identity and own sanitized name/text and role, remain exposed in the current clipped view, and produce a unique same-node XPath. Readiness is observed again. Unrelated carousel, widget and frame changes may proceed; selected-frame navigation or detachment invalidates its targets.

Interpretation, absence, spatial relationships and target enumeration describe captured evidence. New competitors and changed relationships are not semantically rechecked during that request; target-set completeness remains unverified and independently evaluated. The caller can resolve again for fresh interpretation. No automatic retry, additional inference or action execution is added. Capture completeness, passive behavior, target-validation budgets and request-owned charges remain intact. Capture resource ceilings are superseded by [ADR-0030](0030-capture-the-complete-current-view.md).

See the [resolution contract](../resolution.md#target-revalidation).
