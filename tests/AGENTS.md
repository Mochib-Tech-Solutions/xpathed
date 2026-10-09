# Test guidance

Keep the oracle independent: assert intended target/action, page state and effects, not only the emitted XPath or readiness flag. Use `$xpathed-resolution-checks` for browser/provider changes.

- `resolution/` exercises real Browser/service boundaries with deterministic providers by default. C# tests cover service HTTP/contracts; Web tests cover client state and presentation.
- Verify passive resolution leaves scroll/focus/forms unchanged. For explicit execution, verify the intended effect plus stale-target, replay, failure and cancellation behavior when affected.
- Use synthetic secrets to prove privacy exclusion. Screenshots require separate opt-in checks; do not put real credentials or private pages in fixtures.
- Paid checks require explicit scope; report request counts and measured costs separately. Preserve original failed attempts and independent labels; never relax assertions or retry to hide failures.
- Add projects to `Xpathed.slnx` and update CI selection in `scripts/ci-changes.mjs` and `scripts/ci-dotnet-tests.mjs`. Run affected gates from `package.json` and report what actually ran.
