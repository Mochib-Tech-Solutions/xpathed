# Observe action readiness without executing

Keep resolution outcomes separate from action-specific interactability: a verified target can be found with blocked, unsupported or unknown readiness. Browser returns versioned passive DOM observations; stability, keyboard readiness and event outcome stay unknown when checking them would require waiting, focusing or interacting. Preserve the single-action version-1 envelope with additive state/interactability versions so #18 can reuse the per-action contract; sanitized names omit private embedded values instead of forwarding raw accessibility snapshots.

[ADR-0011](0011-report-observed-readiness-and-one-xpath.md) separates passing passive readiness from untested event outcome in interactability version 2; the passive inspection boundary remains.
