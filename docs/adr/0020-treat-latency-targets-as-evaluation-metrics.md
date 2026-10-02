# Treat latency targets as evaluation metrics

Current release acceptance follows [ADR-0023](0023-simplify-release-evaluation.md): latency is descriptive and does not gate approval. The application cancellation decision below remains in force; historical qualification thresholds retain their original meaning only for their recorded evidence.

Status: Accepted, 2026-10-01. Supersedes only the total-response deadline in [ADR-0018](0018-scope-resolution-to-the-current-view.md).

The maintainer clarified that two seconds measures response speed rather than deciding whether the application may return an answer. Remove the Resolver-wide two-second cancellation deadline: return valid slower results with their measured duration. Keep the strictly sub-one-second goal and inclusive two-second qualification threshold; a response can be correct while missing the speed target. Preserve all original attempts and timeouts instead of reinterpreting historical results under this policy.

Provider and client transport timeouts, caller cancellation, Browser capture/validation resource budgets and session isolation remain unchanged. The evaluation-only Jev planner retains its 500 ms allowance before full-evidence fallback; this bounds an optional optimization, not the final response. Each experiment freezes its timing policy and configuration, so results from the previous cutoff remain separate evidence rather than a silently updated baseline.
