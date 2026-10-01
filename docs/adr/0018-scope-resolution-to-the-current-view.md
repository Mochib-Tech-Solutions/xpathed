# Scope resolution to the current view

Status: Accepted, 2026-10-01. Implemented by [#47](https://github.com/Mochib-Tech-Solutions/xpathed/issues/47).

The workspace uses contract 4: one action across distinct targets in the current viewport. “All Approval buttons” means the current view; absence is “not found in the current view,” without an off-screen search. Instructions requiring scrolling, opening controls or a future page state are unsupported. Versions 1–3 preserve their page-wide contracts and historical evidence.

Positive native clipped intersection, including containing frames, establishes scope. Partially visible, disabled, readonly and covered targets remain eligible; readiness is a separate observation. Apply the candidate quota after viewport filtering while retaining scan, document, time and byte bounds. Preserve accessible naming references and structural/relational context. A changed viewport or scroll position invalidates an in-flight capture; completed highlights still follow scrolling.

Appearance starts with bounded browser-measured opaque CSS colors and geometry, not screenshot interpretation. Unknown/complex appearance remains explicit; the model must abstain when a distinction needs missing evidence. The [resolution contract](../resolution.md#current-view-boundary-version-4) defines the exact fields and limitations. Preserve the original instruction and every in-scope candidate identity; the LLM selects targets, and Browser constructs and verifies XPath.

The original decision used a two-second server processing deadline across capture, inference and verification. This total-response deadline is superseded by [ADR-0020](0020-treat-latency-targets-as-evaluation-metrics.md); viewport scope and Browser resource budgets remain unchanged. Timeouts remain failures and never become successful speedups. Preserve request-owned usage and bounded late provider accounting; structured late logs do not rewrite the original timeout record or guarantee reconciliation across process restart. Client transport adds time.

Measure legacy and current-view configurations on paired independently labelled cases using one fixed model/route and one attempt per case/arm. Separate unchanged-target comparisons from scope/capability changes, and keep original dataset quality scores separate from authored browser readiness/plural checks. Preserve exact source/input identities, failures and charges; a measured baseline is not release qualification. This merged baseline becomes the control for the separately blocked [Jev context-planning experiment #48](https://github.com/Mochib-Tech-Solutions/xpathed/issues/48).

Jihed's clarification requires scoped absence, non-interactable reporting and separate XPath expressions per target. The stricter viewport boundary is the maintainer's subsequent product decision. It supersedes off-screen eligibility only for contract 4, not historical outcomes.
