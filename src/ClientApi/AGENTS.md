# ClientApi guidance

Before changing storage, diagnostics, retention or internal access, read [ADR-0013](../../docs/adr/0013-store-diagnostics-as-automatic-backend-logs.md) and the relevant sections of [runtime](../../docs/runtime.md). Use `$xpathed-diagnostics` for the cross-service recording workflow.

Keep persistence behavior in this service. `Data/` owns EF mappings and migrations; controllers remain HTTP adapters. The browser session is transient even when its diagnostic records survive. Reset chat and close-tab operations keep their existing browser/UI meaning.

Treat recording failure separately from the resolution outcome. Bound persistence work and preserve the caller's original status/result. Diagnostic exports and imports are an internal administrative surface; same-origin checks alone do not authorize access to records from other sessions.

## Code Review Rules

- Flag raw request, provider or page payloads reaching the database or operational logs without the documented sanitization and size bounds.
- Flag changes that double-count shared completion cost, replace an original attempt during import, or restore expired browser handles from stored IDs.
- Verify migration/retention behavior against PostgreSQL; an in-memory EF provider cannot establish SQL or constraint correctness.
