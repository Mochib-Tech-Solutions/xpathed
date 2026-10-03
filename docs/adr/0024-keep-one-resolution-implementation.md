# Keep one selected resolution implementation

Keep one resolution implementation, prompt and output schema in `main`, updated in place and versioned through Git. The current implementation resolves one action across current-view targets; omitted `contractVersion` defaults to `"4"`, and retired versions are rejected. Browser and offline selection share the same prompt and validation. This supersedes the legacy compatibility commitments in ADR-0014 and ADR-0018, and the exception for public legacy contracts in ADR-0023.

Remove retired model and context-planning runners from `main`. Keep one engineering comparison harness for the archived Basic resolver, the current Improved resolver and Stagehand. Earlier resolver implementations run from verified image bundles; they do not return as runtime options. Reproduce historical experiments from their recorded Git revisions and artifacts; develop new alternatives on branches. Keep configuration hashes and version metadata as evidence of what ran. Deployment credentials, endpoint and timeout remain operational configuration.

Keep approved image archives, frozen evidence and candidate-versus-approved release evaluation. A change in `main` does not replace the approved baseline or activate a release; those still follow the explicit release process. Saved evaluation artifacts retain their original payloads.
