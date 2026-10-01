# CI checks and evidence

The `Check` workflow runs on pull requests, pushes to `main`, merge groups and manual dispatch. Changed paths select independent .NET, persistence, Web, tooling, Docker-configuration and deterministic-browser jobs. Shared inputs select their consumers; documentation-only changes still run selection and the aggregate. Manual dispatch selects every job.

Every job checks out `github.sha`: the synthetic merge commit for a pull request, the actual pushed revision on `main`, or the merge-group revision. Superseded PR runs can be cancelled; separate `main` revisions do not cancel each other. A failed post-merge check requires investigation and a corrective PR or an explicitly authorized revert; this workflow does not roll back releases.

## Local commit checks

`pnpm install --frozen-lockfile` (also run by setup and restore) installs the checked-in `.githooks` through the root `prepare` lifecycle. Run `pnpm hooks:install` to repair installation, and `pnpm check:staged` to run the pre-commit checks explicitly. Node, pnpm, the pinned .NET SDK and Docker/Buildx must be available on the committing process's PATH when selected checks need them, including commits from an editor.

Installation uses Git's native `core.hooksPath` and worktree configuration. It enables `extensions.worktreeConfig` in the clone and sets the hook path only for the current worktree; repeat installation in each checkout. An existing custom hook path is reported for manual integration instead of overwritten. CI and source copies without a `.git` entry skip installation. Installations that disable lifecycle scripts must run `pnpm hooks:install` explicitly.

`pre-commit` reads staged paths, including deletions and both sides of renames, and reuses `scripts/ci-changes.mjs`:

| Changed inputs | Local checks |
| --- | --- |
| .NET service or its tests | Locked restore, CSharpier, native style checks, Release build/analyzers and the owning unit tests |
| Common or shared .NET configuration | All dependent .NET services and unit tests |
| Solution/build selection | Solution build in addition to selected service checks |
| React/TypeScript workspace | Prettier, ESLint, project typecheck, all frontend tests and Vite build |
| Repository tooling or hooks | Configuration formatting, script syntax and Node tooling tests |
| Docker definitions | Compose configuration and Buildx checks |
| Documentation only | No application builds or tests |

Full-project checks preserve TypeScript configuration and catch dependencies beyond the staged files. Nothing is autoformatted or staged. When executable inputs are selected, unstaged tracked or untracked source/configuration causes rejection before any checks run. Stage the intended changes or set unrelated edits aside yourself; the hook never stashes work. Unstaged documentation and ignored outputs do not block code checks. The hook also rejects index/source changes detected after checking. Keep ignored generated files and dependencies current; this is local feedback, not a hermetic build.

PostgreSQL persistence and deterministic browser integration remain in their isolated CI jobs. Local hooks never start the application stack or call a paid provider. Docker validation can resolve image metadata. The hook fails if a selected tool or check is unavailable; it does not silently skip checks.

## Commit and PR titles

Use `type(scope): description`. Allowed lowercase types are `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style` and `test`. Scope is optional. A breaking change may use `!` before the colon or a `BREAKING CHANGE:` footer. Examples:

```text
fix(browser): preserve target identity
ci: validate affected projects before committing
feat(api)!: change the response contract
```

Git supplies the proposed message to `commit-msg`, which checks the header using `scripts/commit-policy.mjs`. The same validator powers the separate **Commit policy / Conventional commits** workflow. It checks the PR title and every commit introduced by the PR, reruns on title edits, and checks commits pushed to `main`. Existing base history is excluded. Fixup/squash placeholders and Git's default merge/revert subjects must be reworded to the convention before publishing; a valid tip does not excuse an invalid earlier commit. Historical PR title edits do not rewrite merged commits.

Local Git hooks can be bypassed or disabled. CI provides a second check, but merge enforcement requires both `check` and `Conventional commits` as required statuses under an eligible branch-protection/ruleset policy. The current private-repository plan still rejects ruleset access (verified 2026-10-01); see [account controls](#account-controls-remain-separate) and issue #41. Use a conventional PR title for squash merges and verify the final merge message. No history rewrite or account-plan change is part of hook installation.

### Upstream guidance

The implementation follows [Git's hook lifecycle and environment rules](https://git-scm.com/docs/githooks), [worktree-specific configuration](https://git-scm.com/docs/git-worktree#_configuration_file), and the [pnpm lifecycle](https://pnpm.io/scripts). The checked-in shell entry points and existing Node runner cover this repository without a hook-manager dependency. Message structure follows [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) with the explicit type list above.

Stack checks reuse [dotnet format verification](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-format), [dotnet test](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-test), [TypeScript project compilation](https://www.typescriptlang.org/docs/handbook/compiler-options.html), [Vitest's non-watch run](https://vitest.dev/guide/cli.html#vitest-run), and [Docker build checks](https://docs.docker.com/build/checks/). TypeScript documents that passing individual source files changes project-configuration handling, which is why changed paths select the Web project rather than become compiler arguments. PR title validation uses GitHub's [`pull_request.edited` event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request); event text is read as data, never interpolated into shell commands.

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
