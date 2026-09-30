---
name: xpathed-diagnostics
description: Implement or verify xpathed backend resolution records, sanitized evidence, retention and internal diagnostic import/export. Use for persistence changes or missing diagnostics; no frontend history workflow.
---

# Work on backend diagnostics

Read `docs/adr/0013-store-diagnostics-as-automatic-backend-logs.md`, the relevant `docs/runtime.md` sections and `src/ClientApi/AGENTS.md`. Refresh the governing issue when changing accepted behavior. The ADR defines the product boundary; this skill defines the verification workflow.

1. Trace a request through ClientApi, Resolver and Browser using the existing contracts. Identify the owner of every stored field and what remains available if an upstream call fails or cancellation occurs. Keep Browser live handles ephemeral and Resolver independent of the database.
2. Define the stored projection before adding fields: sanitized values, explicit unavailable/redacted evidence, bounded size, retention class and trace/attempt identity. Review instructions, URLs, model text and page evidence as untrusted inputs. Exercise synthetic secrets through every affected path before treating a payload as safe to retain.
3. Preserve original request outcomes and ordered action results. Count shared inference usage/cost once. Keep persistence failure distinct from resolution failure, and distinguish saved-input inspection from fixture-based browser replay.
4. Use the existing EF/PostgreSQL stack. Verify schema upgrades, expiry, duplicate/conflicting imports and restart persistence through the resolution/internal diagnostic API boundary backed by real PostgreSQL. Check invalid/unauthorized requests and records from unrelated sessions at the access boundary. Read current commands from `package.json` and `docs/runtime.md` rather than inventing a parallel test runner.
5. Verify setup and CI select the affected projects/configuration. Update runtime documentation when endpoint, retention or setup behavior changes, then report tested behavior and unavailable evidence explicitly.

Keep automatic recording internal. Resetting the current chat or closing a browser tab is not deletion of diagnostic records. Tests use isolated databases and synthetic data; never reset the development database to prepare a test.
