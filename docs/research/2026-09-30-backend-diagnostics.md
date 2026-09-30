# Backend diagnostics and PostgreSQL

Reviewed 2026-09-30 for #5. Recommendations below fit the accepted automatic backend logging scope in [ADR-0013](../adr/0013-store-diagnostics-as-automatic-backend-logs.md); research is not an additional product specification.

## Existing foundation and structure

The inspected ClientApi already owns a scoped `AppDbContext`, references Npgsql EF Core 10.0.3 and forwards resolution requests through `PagesController`. Compose supplies PostgreSQL 18 and keeps its volume across restarts. Keep this ownership: entities/migrations in `ClientApi/Data/`, logging and import/export behavior in a cohesive `ClientApi/Diagnostics/` folder, and HTTP controllers in `Controllers/`. Shared serialized evidence belongs in Common; Browser and Resolver do not acquire database dependencies. No new project, generic repository, queue or application layer is needed for this local workload. This is a repository-specific recommendation, not a framework-mandated folder layout.

`AddDbContext` registers a scoped context suitable for a request. A context is a short-lived unit of work and cannot be shared across concurrent operations. Await writes; create a separate scope for scheduled cleanup rather than retaining a request context. [EF context lifetime](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/)

## Storage and consistency

Use relational columns for record identity, attempt/session/page identity, timestamps, outcome and expiry; preserve bounded, versioned diagnostic documents in `jsonb`. Npgsql supports string JSON mapping without interpreting its contents. EF 10 complex-type `ToJson` mapping is preferred when querying a strongly typed JSON structure; opaque versioned export documents do not require that extra model. Serialize explicitly with System.Text.Json and validate imports before storage. [Npgsql JSON mapping](https://www.npgsql.org/efcore/mapping/json.html), [Npgsql 10](https://www.npgsql.org/efcore/release-notes/10.0.html)

PostgreSQL `jsonb` does not preserve whitespace, object-key ordering or duplicate keys. Preserve semantic results and schema versions; do not describe a reserialized export as the original byte-for-byte provider response. [PostgreSQL JSON types](https://www.postgresql.org/docs/current/datatype-json.html)

A single `SaveChangesAsync` is transactional. Save a request and its ordered action entries together, with shared usage/cost at request level. Enforce import identity with a database unique constraint, not a read-before-insert check that races. Define repeated identical imports as idempotent and conflicting payloads as conflicts without overwriting the original. These import semantics are a recommendation; the database guarantees uniqueness. [EF transactions](https://learn.microsoft.com/en-us/ef/core/saving/transactions), [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)

## Migrations, retention and failures

Check in generated migrations and the model snapshot. Never combine `EnsureCreated` with migrations. A local single-instance Compose app can apply migrations at startup, but fail clearly if migration cannot finish. For future hosted deployments use a reviewed script or migration bundle as a deployment step; runtime migration requires elevated schema privileges and has operational disadvantages even though EF 9+ adds a migration lock. [Applying migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying)

Keep capture expiry separate from ordinary-record expiry: remove sanitized capture payloads after the configured 30-day default while preserving the ordinary record until its configured 90-day default. Explicitly mark expired evidence. Approved fixtures/qualification evidence require explicit removal. Those are accepted project requirements, not database defaults. A small scheduled cleanup using indexed expiry columns and `ExecuteDeleteAsync`/`ExecuteUpdateAsync` avoids loading expired payloads. These commands execute immediately outside change tracking; use an explicit transaction if several cleanup statements must be atomic. [EF bulk updates/deletes](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete)

Database unavailability must not rewrite a successful resolution into a semantic failure. Report a structured operational logging failure without raw payloads, and bound persistence latency. A canceled caller may still need a bounded attempt-record write; never launch an unobserved task using the disposed request context. This is an implementation recommendation. Without a durable secondary sink, records during database outages or process crashes cannot be guaranteed; document that limit rather than silently claiming every attempt was saved.

## Privacy and verification

Sanitize before persistence, including diagnostic imports. Do not store authorization headers, connection strings, cookies, passwords, access tokens or unrelated form values. Logging being automatic does not make arbitrary page/provider text safe. Prefer allowed structured fields, bounded sanitized evidence and explicit missing-data reasons over raw DOM/provider dumps. Do not enable EF sensitive-data logging: it deliberately includes application values omitted by default. [OWASP logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html), [EF logging](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/simple-logging)

Test persistence against real PostgreSQL. In-memory substitutes do not exercise provider SQL, transactions, JSON behavior, migrations or constraints reliably. Cover migration on an empty database, repeat startup without loss, round-trip export/import, concurrent duplicate imports, multi-action partial outcomes, capture versus record expiry, secret exclusion, malformed/oversized imports and database outage behavior. [EF testing strategy](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy)

For CI, add an independently selected PostgreSQL-backed test job and include its result in the existing stable aggregate gate. Run the API in-process for HTTP tests; a database service does not require building or starting the complete browser/application stack. Keep browser evidence checks deterministic in the existing isolated harness. This is a proposed narrow exception to the current no-service-startup CI convention, requiring matching changes in repository guidance and job-selection tests.

## Local container authentication

The runtime smoke check exposed Npgsql 10 attempting GSSAPI credential discovery on an image without Kerberos. Npgsql documents that this falls back harmlessly and supports `GSS Encryption Mode=Disable` to avoid the attempt. The local password-authenticated Compose connection sets this explicitly; it is not a policy for future hosted TLS settings. [Npgsql security documentation](https://www.npgsql.org/doc/security.html#gss-session-encryption-gss-api).
