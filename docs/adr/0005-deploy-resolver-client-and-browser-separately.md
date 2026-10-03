# Deploy the resolver, client API and browser separately

The assignment uses independently runnable resolver, client application/API and browser services, following the candidate's explicit requirement for standalone components. This replaces the proposal to host the resolver inside the client API: separate deployment and reuse are worth the additional service contracts. The browser service owns live page objects and candidate mappings, exposes operations keyed by the managed page identity, and provides the browser displayed through noVNC; the resolver and client exchange serialized requests and results with it.

The client API forwards workspace requests. The resolver is stateless between requests and the browser service owns temporary browsing state, allowing resolution and standalone evaluations to run without the client application. Workspace chat stays in memory; evaluation runners save their own artifacts. See [ADR-0013](0013-keep-workspace-state-in-memory.md).
