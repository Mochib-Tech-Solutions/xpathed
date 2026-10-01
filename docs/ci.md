# CI checks and evidence

The `Check` workflow runs on pull requests, pushes to `main`, merge groups and manual dispatch. Changed paths select independent .NET, persistence, Web, tooling, Docker-configuration and deterministic-browser jobs. Shared inputs select their consumers; documentation-only changes still run selection and the aggregate. Manual dispatch selects every job.

Every job checks out `github.sha`: the synthetic merge commit for a pull request, the actual pushed revision on `main`, or the merge-group revision. Superseded PR runs can be cancelled; separate `main` revisions do not cancel each other. A failed post-merge check requires investigation and a corrective PR or an explicitly authorized revert; this workflow does not roll back releases.

## Aggregate gate

After its checks succeed, each selected job writes a receipt containing the actual checkout SHA, workflow run and attempt, job identity and workflow/package/SDK fingerprints. Each .NET matrix member has its own receipt. The final `check` job requires exactly the selected receipts and successful job results. Missing, unexpected, stale, skipped, cancelled or failed selected jobs fail the gate; unselected jobs must be skipped.

The browser job runs `pnpm evaluate --mode deterministic` with a fresh output directory and isolated Compose project. It builds only Browser, Resolver and the controlled evaluation fixture. It has no OpenRouter key, reads no local `.env`, and uses the fixture model endpoint with response reuse disabled. Persistence remains a separate PostgreSQL-only job.

Both the browser receipt and aggregate replay the saved browser evidence through the existing grader. They require the complete original `evaluation/cases.json` suite, one first attempt per case, matching source/configuration identities and a saved summary equal to replay. Partial, retried, live, missing or failing results cannot pass. These are deterministic engineering checks; they do not measure model quality or qualify a release.

## Evidence and reruns

Artifacts belong to the private workflow run:

- `ci-receipt-JOB-ATTEMPT`: successful job receipts, retained for 90 days.
- `browser-evidence-ATTEMPT`: controlled-fixture manifest, trials, summaries, diagnostic envelopes and execution log, retained for 30 days, including failed runs when evidence exists.
- `ci-gate-ATTEMPT`: aggregate JSON decision and failure reason, retained for 90 days; the decision also appears in the job summary.

Only these explicit paths are uploaded. Local datasets, environment files, user browsing data and experiment ledgers are excluded. Expired browser evidence cannot be replayed from the longer-lived receipt alone.

Inspect the failing job and `gate.json` before rerunning. **Rerun the entire workflow**, not only failed jobs: every selected receipt must belong to the same attempt. GitHub's **Re-run all jobs** or `gh run rerun RUN_ID` creates a fresh attempt without mixing earlier results. A new commit gets its own PR check; after merge, verify the separate push run against the merged SHA.

Local gate tests run through `pnpm test:tooling`; they exercise the public receipt/verification CLI, including negative status, identity, coverage and artifact cases. Use `pnpm evaluate` for the real-browser suite. Paid model testing remains separate from these automatic checks. The manually dispatched [release workflow](releases.md#manual-github-qualification) uses a dedicated secret and durable shared budget; it has no PR, push or schedule trigger.

## Account controls remain separate

A green workflow does not establish required checks, protected merges or an independent review. On 2026-10-01, GitHub reported this private organization's plan as Free, `main` as unprotected, and protection/ruleset endpoints as plan-gated. Organization-owned private repositories require an eligible organization plan for these controls; a personal Pro upgrade does not address that requirement. No plan purchase or visibility change is part of this implementation.

Copilot billing configuration also does not prove review execution. No actual Copilot PR review was verified during the audit. [Issue #41](https://github.com/Mochib-Tech-Solutions/xpathed/issues/41) tracks the remaining protection and review evidence, split from completed implementation issue #10 at the maintainer's request. Once account access permits it, configure the required `check` result and review policy, exercise a deliberately failing PR, verify that merge is blocked, and record an actual Copilot review before marking those criteria complete. Do not infer enforcement from workflow YAML or enable paid review without authorization.

References: [protected-branch availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository), [Copilot review](https://docs.github.com/en/copilot/concepts/agents/code-review), and [workflow event revisions](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).
