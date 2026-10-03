# ADR-0016: Qualify models by correct, complete response latency

Current release design is superseded by [ADR-0023](0023-simplify-release-evaluation.md). The rules below describe historical decisions and remain relevant to their original artifacts; they are not additional gates for new release PRs.

Status: Accepted

## Decision

Compare explicit standard model/provider configurations using the existing managed-browser evaluator and target oracle. Keep one baseline prompt, schema and DOM representation across models. Treat the concise prompt as a separately identified development experiment. Preserve shared-action whole-target-set/action/readiness grading and legacy regression coverage.

The timing policy accepted 2026-10-01 targets strictly under one second and requires at least 95% of planned requests correct and complete within two seconds. This supersedes the original two-second goal and three-second deadline; recorded historical results retain their original policy. Freeze numerical correctness, family and critical-case gates before held-out inference. Report uncertainty and limitations; the observed suite gate is not a production percentile guarantee. Rank speed only among eligible configurations, with cost constrained by the existing shared $10 experiment ledger.

Every billed attempt reserves first and reconciles reported usage. Standard routes are pinned without fallback or response reuse. Retain requested/observed identity, supported settings, model reasoning and provider prompt-cache evidence. Missing charges stop further calls. Trials run serially in seeded, interleaved order without retries or discarded warmups.

Experimental candidates do not change the approved default. A complete comparison with no qualifying model is a valid outcome. Release promotion and hosted quality enforcement remain separate issue scope.

## Consequences

Existing runners, grading and ledger ownership remain intact; no additional provider SDK or production service is required. Evaluation adds isolated Resolver configurations and independent held-out fixture families. Report the local pricing-snapshot measurement difference from production network lookups. Historical page-wide captures have no computed color evidence. [ADR-0018](0018-scope-resolution-to-the-current-view.md) adds bounded CSS color evidence and a separately measured current-view baseline; it does not retroactively qualify those historical runs. Saved-page selection scores from external datasets cannot establish browser readiness or plural behavior.

Adding Qwen3.8 Flash uses the same baseline prompt on an explicit standard Alibaba route with reasoning disabled. Previously exposed held-out families move to regression with original split/run provenance. Reassessing historical timings is retrospective analysis, not new qualification; new independent holdout families are required before promotion.

Evidence expires under the existing local artifact retention policy. Keep sanitized configuration fingerprints and aggregate reports separately from page evidence; preserve the charge ledger across run cleanup.
