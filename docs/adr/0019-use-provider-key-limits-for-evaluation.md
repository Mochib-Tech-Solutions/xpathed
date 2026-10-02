# Use provider key limits for evaluation spending

[ADR-0023](0023-simplify-release-evaluation.md) extends this decision: costs, missing billing metadata and accounting-service availability are informational and cannot block new evaluations. Historical charge records remain intact.

Accepted, 2026-10-01. The maintainer removed local research spending checks, including the former $10 cumulative campaign ceiling and proposed $0.10 Jev allocation. New live evaluations rely on the configured provider key limits and provider responses; key cap amount, reset schedule, remaining credit, forecasts and unknown charges do not create additional local spending gates.

Keep the shared authoritative ledger and every historical entry, reported charge, unknown cost and reservation review. Mark the new policy explicitly; historical ceilings and reports retain their original meaning. Money estimates remain informational, never invented reported costs. Durable evidence failures, wrong provider/model, malformed requests, hidden retries and response reuse remain independent integrity failures.

Control consumption through experiment scope: a small representative pilot, one attempt per case/approach, existing input/output limits, standard routes, and expansion only when the evidence supports it. This decision adds no scheduled paid work, runtime promotion, key-limit change or account refill. The application key remains separate from the evaluation key. It supersedes the local monetary gates in ADR-0017 while preserving that decision's durable accounting and source-identity requirements.
