# Resolver guidance

For model selection, result contracts or diagnostics, read [resolution](../../docs/resolution.md); use `$xpathed-resolution-checks` for verification. Diagnostic recording follows [ADR-0013](../../docs/adr/0013-store-diagnostics-as-automatic-backend-logs.md), with persistence owned by ClientApi.

Keep orchestration in `Services/ResolutionService.cs`, model selection/validation in the existing strategy classes, and provider transport in `OpenRouterGateway`. Extend the owner of a behavior rather than duplicating response validation in controllers.

The model chooses captured candidate IDs. Browser verification supplies the XPath and same-node evidence; provider text cannot replace that verification. Partial capture/input must remain explicit rather than turning an incomplete search into a confident absence.

## Code Review Rules

- Flag diagnostics that change semantic outcomes or collapse `not_found`, unsupported scope and technical failure into one category.
- Flag per-action copies of request-owned usage/cost or diagnostics that lose the original attempt identity.
- Flag database dependencies, unsanitized model-request logging, or retries that silently add provider calls/cost. Test provider behavior with deterministic HTTP responses; live pricing/quality evidence is a separate check.
