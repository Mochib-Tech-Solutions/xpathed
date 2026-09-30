# Backend diagnostics

Every valid application resolution request automatically starts an internal diagnostic record before calling Resolver. Completion updates that attempt, while retries get new identities. No frontend controls are added. Reset chat, tab closure and app reload clear workspace state independently of stored records. Browser objects remain transient; records cannot restore a live session or prove that an old XPath still works.

ClientApi owns EF Core/PostgreSQL storage. Resolver's internal evidence endpoint returns a result plus a bounded sanitized representation; its public resolution response remains unchanged. ClientApi returns only the ordinary result to Web. The standalone evaluator can continue without ClientApi or PostgreSQL and later import its artifacts.

## Recorded evidence

Records contain request/attempt identity, page/document/capture/frame references, ordered action results and summary, target state/readiness observations, diagnostics, model configuration and request-owned usage/cost. A multi-action request stores its shared cost once. W3C trace IDs correlate HTTP calls and structured failures across services. Operational errors, evaluation mismatches and confirmed semantic errors remain separate; `not_found` alone is not a failure.

The stored projection excludes form values, cookies/storage credentials and recognized secrets. Instructions requesting entered values and their content-bearing results are conservatively redacted; their model input is withheld. Ordinary model input is the existing bounded candidate representation, sanitized again for persistence. URL credentials, queries and fragments are removed. Provider raw responses and browser handles are not retained. Redaction can remove useful context: stored evidence is a sanitized diagnostic view, not byte-for-byte provider-request replay. Missing, withheld and expired evidence remains explicit.

Database writes have a two-second deadline each. A failed write emits an operational storage error and does not change the resolver's semantic outcome. A pending record can remain if the process stops before completion. If Resolver fails before returning diagnostics, ClientApi records the known request and operational failure with unavailable evidence. If PostgreSQL is unavailable, durable recording cannot be guaranteed; health/logging exposes that failure.

## Schema and migrations

`diagnostic_records` stores one record per primary-key ID. IDs, kind, trace, page, outcome and timestamps are relational; result, evidence and provenance use PostgreSQL `jsonb`. Expiry and page/time indexes support retention and bounded lookup. EF contexts are request-scoped; each save is atomic. Imports use the primary-key constraint and a canonical sanitized-content hash to handle concurrent duplicates without overwriting originals.

The local Compose database uses password authentication and explicitly disables unused GSSAPI negotiation. The checked-in initial EF migration upgrades an empty database; the model snapshot supports later migrations. Compose explicitly enables `Diagnostics__MigrateOnStartup=true` for the local single-instance application. Outside Compose it defaults off. Migration failure prevents startup rather than pretending the schema is ready. Hosted deployment remains future work and should apply reviewed migrations separately with deployment credentials.

```sh
rtk dotnet tool restore
rtk dotnet ef migrations add MeaningfulChange --project src/ClientApi --output-dir Data/Migrations
rtk dotnet ef migrations has-pending-model-changes --project src/ClientApi
```

Review generated migrations before applying them. Preserve existing volumes. `pnpm test:persistence` uses a supplied PostgreSQL test connection with create-database permission; its fixture creates and deletes uniquely named test databases, never the supplied database itself. CI supplies an isolated PostgreSQL service. Migration/model drift, restart persistence, concurrent writes, operational failures, sanitization, imports and expiry are checked through the API boundary.

## Retention

The defaults are 90 days for ordinary records and 30 days for page evidence. Compose accepts `DIAGNOSTIC_RECORD_DAYS` and `DIAGNOSTIC_CAPTURE_DAYS`; direct configuration uses `Diagnostics__RecordRetentionDays` and `Diagnostics__CaptureRetentionDays`. Approved sanitized regression fixtures and qualification evidence remain until explicit deletion, with review provenance required on import. The hourly worker deletes expired records and erases expired evidence in bounded batches; reads immediately hide expired data even before a cleanup batch runs. Imports cannot extend the configured maximum retention.

## Operator access

Run `pnpm diagnostics -- <command>` from the checkout with the local stack running. The wrapper executes the application CLI inside ClientApi; it needs no extra HTTP client or exposed port. Commands also work as `dotnet ClientApi.dll diagnostics ...` with a configured database. CLI output is JSON; errors use fixed codes and a nonzero exit.

```sh
rtk pnpm diagnostics -- list
rtk pnpm diagnostics -- list PAGE_ID
rtk pnpm diagnostics -- export ATTEMPT_ID > /tmp/diagnostic.json
rtk pnpm diagnostics -- import < /tmp/diagnostic.json
rtk pnpm diagnostics -- prune
rtk pnpm diagnostics -- delete ARTIFACT_ID
```

Equivalent internal HTTP routes are `GET /internal/diagnostics` (optional `pageId`, `traceId`, `limit` up to 100), `GET /internal/diagnostics/{id}`, `POST /internal/diagnostics/import`, `POST /internal/diagnostics/prune` and `DELETE /internal/diagnostics/{id}`. They accept local operator access only, reject browser Origin headers and remote IPs, and are explicitly unavailable through the Web proxy. These are local administrative capabilities, not a hosted authorization model.

## Version 1 import/export envelope

The JSON envelope contains `version` (`"1"`), `id`, `kind`, `traceId`, `pageId`, `outcome`, `createdAt`, nullable `expiresAt`/`evidenceExpiresAt`, `evidenceAvailability`, object `result`, nullable object `evidence` and object `provenance`. Import requests are limited to 2 MB. Identifiers are bounded; unknown envelope fields, invalid dates, unsupported versions/kinds and missing provenance are rejected.

Kinds are `resolution`, `evaluation`, `saved_case`, `model_configuration`, `regression_fixture` and `qualification`. Provenance requires `source`, `schemaVersion` (`"1"`), `codeVersion`, `configurationId` and `caseId`; unavailable values are explicit. Indefinite retention additionally requires `approved: true`, `reviewedBy` and `reviewedAt` for the eligible kinds. Keep reviewed corrections as distinct artifact IDs linked through provenance; they do not replace original attempts.

Reimporting the same sanitized artifact is idempotent. A different payload with an existing ID returns `409 artifact_conflict`. Import does not run a model or grade a case. The evaluator's detailed case/run payload is defined in #6; this envelope preserves its provenance and original outcome without claiming evaluation or approval occurred here. Inspecting saved input is possible with retained evidence; full browser replay still requires a reconstructible, versioned fixture.
