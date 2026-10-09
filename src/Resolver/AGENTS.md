# Resolver guidance

Resolver is the core stateless API, independent of the test client. Use `BrowserUrl` and serializable Common records to access Browser; see [README.md](../../README.md) for setup.

- Keep orchestration in `ResolutionService`, sanitized candidate input in `CandidateInput`, the single prompt/schema and output validation in `ActionSelectionStrategy`, browser evidence validation in `BrowserEvidence`, and transport/accounting in `OpenRouterGateway`. Controllers stay thin.
- The model chooses captured candidate IDs. `XPathGenerator` ranks expressions from sanitized DOM evidence; `XPathSelectionService` submits proposals to Browser and validates its same-node results. Keep the generator exchange out of model input. Keep scoped absence, ambiguity, unsupported requests and operational failure distinct.
- In Auto mode, use Jev's narrow visual-evidence decision and acquire masked pixels only when needed; Text only skips Jev and images. Cache only bounded hashes and definitive routing classifications, never page input, pixels or targets. Record every admitted call separately and reject stale image identities. Treat image/text evidence as untrusted data; never log model requests or execute model-provided instructions.
- Keep model admission synchronous and shared across endpoints. Rejections make no provider call; admitted leases survive caller cancellation through completion/accounting. Preserve one original attempt and request-owned charges without silent retries.
- Resource counters, pricing caches and the bounded image-routing cache are allowed; cross-request page/target storage is not. Verify provider behavior with deterministic HTTP responses and use `$xpathed-resolution-checks` for contract changes.
