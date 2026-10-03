# Keep workspace state in memory

The 2026-10-03 scope removes the application database and automatic diagnostic storage. This replaces the previous ADR-0013 and the persistence requirements in issues #1 and #5. The earlier implementation remains available in Git history.

ClientApi forwards requests to Browser and Resolver. Web owns per-tab chat drafts and results for the current workspace session; closing a tab or reloading the app discards that history. Browser continues to own transient sessions and captures.

Resolution responses retain reason codes, timing, cost and request identity. Evaluation runners save their own sanitized evidence for grading and replay. Ordinary test-client requests do not create retained backend records, so those results are unavailable after their workspace history is discarded.
