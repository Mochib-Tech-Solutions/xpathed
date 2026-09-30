# Test guidance

Keep the oracle independent of the implementation: assert the intended target/action and preserved page state, not only an emitted XPath string or returned `ready` flag. Use `$xpathed-resolution-checks` for browser and provider scenarios; use `$xpathed-diagnostics` for stored attempts and imports.

`resolution/` exercises real browser/service boundaries using a deterministic provider by default. C# projects exercise their service's HTTP/contract boundary. Select PostgreSQL for migration, expiry and database-constraint behavior; mocked HTTP services are appropriate for deterministic upstream failures.

Add projects to `Xpathed.slnx` and account for selection in `scripts/ci-changes.mjs` and `scripts/ci-dotnet-tests.mjs`. A passing local test is not evidence that its CI path runs; validate selection too.

## Code Review Rules

- Flag retries or relaxed assertions that conceal the original failure, and tests whose expected values are computed by the code under test.
- Flag fixture data containing real credentials or unrelated user page content. Use synthetic secrets to prove exclusion.
- Keep paid live provider checks explicit and report their measured usage/cost separately from deterministic checks.
