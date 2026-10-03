# ClientApi guidance

ClientApi forwards test-client requests to Browser and Resolver. Keep controllers as HTTP adapters using `HttpForwarder`; preserve upstream status, content type and response body, and propagate request cancellation. `/health` reports service liveness and the supported resolution contract.

Chat drafts and results belong to each tab in the Web workspace session. Evaluation runners own their saved artifacts. See [runtime](../../docs/runtime.md) for service routes and lifecycle ownership.

## Code Review Rules

- Preserve same-origin checks and keep page content, credentials and upstream exception payloads out of operational logs.
- Route resolution to the public Resolver endpoint for the requested managed page.
- Verify forwarding and health behavior through the HTTP boundary with controlled upstream responses.
