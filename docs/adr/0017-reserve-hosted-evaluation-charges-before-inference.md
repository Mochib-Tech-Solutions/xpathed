# Reserve hosted evaluation charges before inference

Status: Accepted

The maintainer authorized manual GitHub qualification after provisioning a dedicated evaluation key. PR/push checks remain deterministic; scheduled paid monitoring needs a separate recurring budget decision. The original $5 campaign remains cumulative across local and hosted experiments.

The authoritative charge ledger moves intact to the private `evaluation-budget` branch. Each reservation and reconciliation uses the GitHub Contents API with the last observed file SHA; a missing ledger, conflicting update, unavailable persistence or unresolved charge blocks inference. Uploading the ledger only after a workflow finishes cannot protect the budget when a runner disappears after billing. Local copies carry the authority marker and cannot resume independent spending. Repository-wide workflow concurrency supplements these conditional writes; it does not replace them.

Qualification runs the verified bundle's exact Browser/Resolver images and records their running container identities before and after evaluation. Image changes cannot inherit pilot evidence. A complete measurement remains distinct from an artifact-bound qualified candidate, and neither changes the application's default.
