# ADR-0016: Qualify models by correct, complete response latency

Status: Accepted

## Decision

Compare explicit standard model/provider configurations using the existing managed-browser evaluator and target oracle. Keep one baseline prompt, schema and DOM representation across models. Treat the concise prompt as a separately identified development experiment. Preserve contract-3 whole-target-set/action/readiness grading and legacy regression coverage.

The accepted target is two seconds where possible, with at least 95% of planned requests correct and complete within three seconds. Freeze numerical correctness, family and critical-case gates before held-out inference. Report uncertainty and limitations; the observed suite gate is not a production percentile guarantee. Rank speed only among eligible configurations, with cost constrained by the existing shared $5 experiment ledger.

Every billed attempt reserves first and reconciles reported usage. Standard routes are pinned without fallback or response reuse. Retain requested/observed identity, supported settings, model reasoning and provider prompt-cache evidence. Missing charges stop further calls. Trials run serially in seeded, interleaved order without retries or discarded warmups.

Experimental candidates do not change the approved default. A complete comparison with no qualifying model is a valid outcome. Release promotion and hosted quality enforcement remain separate issue scope.

## Consequences

Existing runners, grading and ledger ownership remain intact; no additional provider SDK or production service is required. Evaluation adds isolated Resolver configurations and independent held-out fixture families. Report the local pricing-snapshot measurement difference from production network lookups. Color-only references remain an explicit capture capability gap, and external offline dataset scores cannot establish browser readiness or plural behavior.

Evidence expires under the existing local artifact retention policy. Keep sanitized configuration fingerprints and aggregate reports separately from page evidence; preserve the charge ledger across run cleanup.
