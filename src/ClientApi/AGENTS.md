# ClientApi guidance

ClientApi forwards test-client requests to Browser and Resolver. Keep controllers as HTTP adapters using `HttpForwarder`; preserve upstream status, content type, body and cancellation. `/health` reports liveness.

- Keep same-origin checks and credentials, page content and upstream exception payloads out of operational logs.
- Route resolution and explicit execution to the requested managed page. Per-tab chat state belongs to Web.
- Verify forwarding and health behavior through the HTTP boundary with controlled upstream responses. Use [README.md](../../README.md) for setup and source Common contracts for request shapes.
