# Store diagnostics automatically in the backend

The user's 2026-09-30 clarification makes issue #5 internal diagnostic logging: automatically persist every resolution attempt and its sanitized evidence, with no frontend history browser, export control or capture-consent prompt. This supersedes the ordinary-history UI and opt-in capture requirements in the earlier #1/#5 wording; the current session chat remains, and resetting chat or closing tabs does not delete backend records.

ClientApi owns persistence and internal diagnostic import/export; Resolver remains stateless and Browser retains transient live objects. Automatic collection preserves the existing sanitization boundary: exclude secrets, passwords, cookies/storage credentials and unrelated form values before persistence, including in page evidence and model-request records. Keep bounded evidence and explicit missing-data metadata rather than claiming a complete capture when unavailable. Retain the configurable defaults of 90 days for ordinary records, 30 days for sanitized page captures and explicit removal for approved sanitized regression fixtures and qualification evidence. Saved evidence supports inspection; only reconstructible fixtures support historical browser replay.

The implementation contract is documented in [backend diagnostics](../diagnostics.md).
