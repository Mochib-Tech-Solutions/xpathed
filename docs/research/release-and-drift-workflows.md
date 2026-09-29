# Release qualification and nightly drift workflows

Research checked 2026-09-29. This is a proposed design; workflows, repository protection, notification settings, and email delivery have not been configured or verified by this research.

## User decisions

- No evaluation spending cap for now. Estimate and report each configuration's usage and cost.
- Run full qualification on release branches; run important regression cases nightly against the approved default.
- A drift failure must fail the pipeline and alert the maintainer. It must never disable the running feature, switch its model, or change its approved default automatically.
- Release qualification still controls whether a new resolver release may be promoted. That gate is separate from availability of the current release.

## Proposed triggers

| Trigger | Work |
| --- | --- |
| PR targeting `main` or `release/**` | Required builds, static checks, deterministic/browser/database tests; agreed live regression checks for relevant trusted changes |
| Push to `main` | Repeat integration tests and live regression evaluation on the actual merged commit |
| Push to `release/**` | Full qualification against every eligible case in each versioned dataset/split, with separate dataset reports and documented exclusions |
| Nightly schedule | Important regression subset, fresh inference using the approved default's frozen artifact/configuration |
| Explicit promotion | Verify qualification evidence and activate the exact qualified artifact/configuration |

GitHub supports push branch patterns such as `release/**`; PR branch filters refer to the target branch. Prefer one reusable evaluation implementation invoked by these workflows. [Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)

Create each release candidate from a tested `main` SHA. If it needs a fix, merge the fix through its PR and qualify the updated candidate. Record source SHA, artifact digest, resolver manifest, dataset/grader/browser revisions, run ID, and completeness in qualification evidence. Promote that exact artifact. A release-branch result does not qualify a newly built, different merged-main artifact: evaluate the changed artifact before promotion. These are proposed safeguards against testing one version and deploying another.

Required checks must correspond to the latest relevant commit. Use an always-running aggregate gate that fails when a required child evaluation is missing, failed, cancelled, or unexpectedly skipped; GitHub can otherwise accept skipped/neutral checks. Require this gate in branch protection and validate post-merge separately. [Required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)

## Nightly execution and stable comparisons

The schedule definition must exist on the default branch, and GitHub starts scheduled workflows from that branch. A proposed cron is `17 2 * * *` (02:17 UTC). Schedules can be delayed or dropped under load; avoid the start of the hour. [Scheduled events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

Starting from `main` must not silently test the latest development resolver. Read the approved-default manifest once, record its identity, and run its immutable artifact digest with pinned evaluation assets. If rebuilding is necessary, checkout the manifest's exact commit SHA and locked dependencies, then disclose that this is a rebuild rather than the originally qualified artifact. Checkout supports a commit SHA as its `ref`. [Checkout](https://github.com/actions/checkout)

Use a trusted manifest from the protected repository, with read-only repository/package permissions and provider access limited to the evaluation job. Fail if the manifest or artifacts are absent or inconsistent; never substitute `latest`. Pin the grader and nightly case manifest too. A changed grader or case set requires a new baseline rather than a claim of provider drift.

Run fresh inference with fixed inputs and predeclared repetitions. Report quality, contract failures, errors, completion, latency, and cost separately. Classify infrastructure failures separately from semantic failures. Preserve the original failure if a bounded diagnostic rerun passes. See [the drift research](resolver-comparison-and-drift.md).

Write failure evidence and summaries even when evaluation fails; leave the gate genuinely failed. Do not mask it with `continue-on-error`, which can make a failing job or workflow pass. Runtime state remains untouched. [Workflow failure behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idcontinue-on-error)

## Native email notifications

GitHub Actions email notifications depend on the recipient's notification settings. Enable Actions email delivery and the failed-workflows-only option for the maintainer account; use a verified permitted email address. Account settings are not established by committing a workflow. [Actions notification settings](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications), [Email delivery](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications)

Ordinary run notifications concern workflows the user triggered. Scheduled notifications initially go to the workflow creator, then to a user who changes its cron expression, or the user who re-enables a disabled schedule. Confirm the intended maintainer is the scheduled recipient after changes. [Workflow notifications](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)

Minimum acceptance checks when implementing:

1. Verify the maintainer's Actions email/failure preferences and verified destination.
2. Trigger a deliberate failing test workflow as that maintainer and confirm the actual email links to its failed run.
3. Verify a scheduled failure reaches the intended recipient; a manually triggered failure alone does not test scheduled routing.
4. Confirm the feature remains available and its approved-default identifier is unchanged after failure.
5. Remove the deliberate fault and confirm the genuine evaluation result determines the next run.

Native scheduling/email is best effort: a dropped schedule creates no failed run and therefore no failure email. Report last completed run time in the evaluation history. Independent missing-run alerting can be added if guaranteed detection becomes a requirement. This research did not send email or alter notification preferences.
