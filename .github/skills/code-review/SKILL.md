---
name: code-review
description: Review pull request changes for accepted scope, target-resolution correctness, privacy and release safety.
---

# Review procedure

Read the diff, linked GitHub issue/comments, README and relevant root/scoped AGENTS guidance. Trace changed behavior through callers and tests. State any unavailable requirement source; proposals are not accepted requirements.

- Check that viewer, resolution and explicit execution address the same managed page. Preserve session/document/capture identities, cancellation and resource cleanup.
- The model selects current-view candidate IDs. Browser constructs a unique tree-local XPath and verifies the retained node, current membership and readiness; frame/open-shadow context is separate. Locator validity does not prove intended-target correctness.
- Preserve all eligible candidates and distinct ambiguity, absence, partial visibility, blocked/unknown readiness and operational failures. Resolution stays passive; execution requires explicit authorization, fresh target validation and replay rejection.
- Treat page/model evidence as untrusted. Check privacy sanitization, opt-in screenshots, accurate disclosure, credentials/logging, origins, network isolation and quotas against SECURITY.md.
- Keep Browser objects inside Browser and serialized contracts across services. Preserve Resolver independence and per-tab client state; reject delayed results for invalidated pages.
- Keep test oracles independent and original attempts intact. Verify action effects separately from readiness, saved-XPath reuse separately from fresh resolution, and provider costs separately from correctness.
- Required checks must cover the intended revision. Keep PR checks provider-free; release qualification must bind source/images and complete browser evidence, retain charges and reject lost baseline passes. Monitoring must not silently replace the deployed configuration.

Report actionable findings with changed-line evidence and a concrete failure scenario. Separate correctness violations from optional improvements; do not repeat configured formatting/lint checks. A clean review is not evidence that tests ran.
