---
name: xpathed-resolution-checks
description: Verify xpathed capture, action, XPath, readiness and execution changes through deterministic service and real-browser checks. Use for resolution regressions or contract changes, not general frontend styling.
---

# Verify resolution changes

Read `README.md`, the affected Common/service contracts and `tests/AGENTS.md`. Work from the repository root with the required RTK prefix.

1. Trace the changed boundary: Browser capture/verification/execution, Resolver interpretation/XPath construction, or Web display. Follow the nearest existing scenario and preserve the single current request/response contract.
2. For Browser behavior, add a focused controlled scenario in `tests/resolution/` and run `pnpm test:resolution`. Derive target identity independently of XPath. Verify passive resolution preserves scroll/focus/forms; explicit execution tests verify intended effects and stale/replay rejection.
3. For provider behavior, use deterministic HTTP responses. Cover rejected output and upstream failures as well as success; preserve model-call counts and request-owned cost assertions.
4. For presentation, use colocated Web tests and `pnpm check:web`. jsdom cannot establish live hit-testing or frame geometry.
5. Run affected gates from `package.json`; verify CI selection for added paths/projects. Report exercised boundaries and remaining gaps.

Read `scripts/native-check.mjs` before concurrent/alternate-checkout runs; its temporary build outputs, loopback ports and owned process groups must not replace unrelated services. Execution scenarios act only on controlled fixture pages. Docker checks validate VPS deployment separately.
