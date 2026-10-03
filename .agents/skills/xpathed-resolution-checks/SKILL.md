---
name: xpathed-resolution-checks
description: Verify xpathed capture, action, XPath and readiness changes through deterministic service and real-browser checks. Use for resolution regressions or contract changes, not general frontend styling.
---

# Verify resolution changes

Read `docs/resolution.md` for the affected contract and `tests/AGENTS.md` for test ownership. Work from the repository root; use its documented RTK prefix.

1. Identify which boundary changed: browser capture/selection, resolver/provider interpretation, or Web display. Follow the existing scenario nearest that boundary. Verify the single current-view request and response contract; Git records historical implementations. Historical evidence retains its original payload.
2. For browser behavior, add a controlled scenario in `tests/resolution/` and run `pnpm test:resolution`. Derive expected target identity independently of the returned XPath; verify one intended match in its frame context, correct action observations and unchanged scrolling/focus/form state where relevant. Include the failure that motivated the change, not a broad inventory of unrelated cases.
3. For provider behavior, use deterministic responses in the existing service/pipeline tests. Check rejected model output and upstream failures as well as success. Keep model-call counts and request-owned cost assertions when changing orchestration.
4. For displayed observations, use colocated Web tests and `pnpm check:web`. A jsdom assertion cannot establish live browser hit-testing or frame geometry.
5. Run affected local gates from `package.json`; check CI selection for added projects or paths. Report which boundaries were actually exercised and any gaps.

`pnpm test:resolution:live` is a separate paid check when the task calls for real provider evidence. Follow the current cheap-route/output-limit guidance in `docs/resolution.md`, preserve reported and estimated costs separately, and retain the measured result. Deterministic fixtures are the default.

The runner owns an isolated Compose project and port; read `scripts/resolution-check.sh` before concurrent or alternate-checkout runs. Preserve unrelated development stacks. This workflow does not execute the user's requested page actions.
