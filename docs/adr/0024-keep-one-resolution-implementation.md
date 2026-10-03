# Keep one resolution implementation

Keep one resolver implementation, prompt and output schema, updated in place. Git records changes; runtime requests, readiness observations and diagnostics carry their actual fields without manually maintained prompt, contract, capture or XPath revision numbers. Historical experiments remain reproducible from their Git commits and saved evidence.

The resolver handles one action across distinct current-view targets. Browser and offline selection share the prompt and validation. Source commits, image digests and content hashes identify evaluated code and artifacts. The release branch determines the release under [ADR-0026](0026-use-the-release-branch-as-the-baseline.md).
