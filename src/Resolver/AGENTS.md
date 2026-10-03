# Resolver guidance

Resolver is the core system. Keep it independent of the test client. Access browser implementations through the configured `BrowserUrl` HTTP API and shared Common records; follow [browser integration](../../docs/runtime.md#browser-integration) when changing that boundary.

For model selection, result contracts or diagnostics, read [resolution](../../docs/resolution.md); use `$xpathed-resolution-checks` for verification. Evaluation runners retain the evidence returned by the internal resolution endpoint.

Keep orchestration in `ResolutionService`, candidate serialization in `CandidateInput`, the single prompt/schema and model-output validation in `ActionSelectionStrategy`, browser-response validation in `BrowserEvidence`, and provider transport/accounting in `OpenRouterGateway`. Runtime resolution and Saved-page selection use the same prompt. Update these implementations in place; follow [ADR-0024](../../docs/adr/0024-keep-one-resolution-implementation.md) when changing configuration or considering alternatives. Controllers only handle HTTP boundaries.

The model chooses captured candidate IDs. Browser verification supplies the XPath and same-node evidence; provider text cannot replace that verification. Partial capture/input must remain explicit rather than turning an incomplete search into a confident absence.

## Code Review Rules

- Flag diagnostics that change semantic outcomes or collapse `not_found`, unsupported scope and technical failure into one category.
- Flag per-action copies of request-owned usage/cost or diagnostics that lose the original attempt identity.
- Flag database dependencies, unsanitized model-request logging, or retries that silently add provider calls/cost. Test provider behavior with deterministic HTTP responses; live pricing/quality evidence is a separate check.
