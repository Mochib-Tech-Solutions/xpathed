# Reserve hosted evaluation charges before inference

Status: Accepted

The maintainer authorized manual GitHub qualification after provisioning a dedicated evaluation key. PR/push checks remain deterministic; scheduled paid monitoring needs a separate recurring budget decision. On 2026-10-01 the maintainer explicitly raised the existing campaign ceiling from $5 to $10. All prior charges and reviewed reservations remain cumulative across local and hosted experiments; this is not a reset or a new $10 allowance. The dedicated inference key may have a larger finite non-resetting cap ($15 as accepted on 2026-10-01); the authoritative ledger limits this campaign to $10. Key metadata checks do not spend inference credits.

The authoritative charge ledger moves intact to the private `evaluation-budget` branch. Each reservation and reconciliation uses the GitHub Contents API with the last observed file SHA; a missing ledger, conflicting update, unavailable persistence or unresolved charge blocks inference. Uploading the ledger only after a workflow finishes cannot protect the budget when a runner disappears after billing. Local copies carry the authority marker and cannot resume independent spending. Repository-wide workflow concurrency supplements these conditional writes; it does not replace them.

Qualification runs the verified bundle's exact Browser/Resolver images and records their running container identities before and after evaluation. Image changes cannot inherit pilot evidence. A complete measurement remains distinct from an artifact-bound qualified candidate, and neither changes the application's default.

The 2026-10-01 current-view development baseline exposed a measurement confound: the two GitHub writes alone exceeded the runtime deadline. Its prospective `resolver-http-pre-reserved-v2` protocol durably reserves the frozen conservative ceiling before timed resolution and reconciles after returning the provider response. Actual requests must still fit the reservation and approved route; another attempt and final reporting wait for settled accounting. Unknown/unused reservations and write failures halt the run. The original failed measurement remains unchanged. This isolates test bookkeeping without changing the application deadline, release qualification timing, campaign ceiling or production configuration.

The local monetary gates in this decision are superseded by [ADR-0019](0019-use-provider-key-limits-for-evaluation.md). Historical evidence remains unchanged; durable accounting and source identity still apply.
