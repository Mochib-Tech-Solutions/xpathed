# Release monitoring setup

Checked 2026-10-01 against official GitHub documentation for #11. This research does not configure account settings, publish artifacts, dispatch workflows or verify email delivery. The current user request authorizes recurring monitoring with `OPENROUTER_EVAL_API_KEY`; older notes deferring that authorization need updating during implementation.

## Failure notifications

Repository administrator status alone does not establish delivery. GitHub documents Actions notifications for runs the user triggers, provided email or web notifications are enabled. Scheduled notifications initially go to the workflow creator, then to the user who edits the cron expression, or the user who re-enables a disabled workflow. [Workflow notifications](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)

For the intended maintainer, verify repository watching and **Settings → Notifications → System → Actions → Email**. Select **Only notify for failed workflows** if desired. These are personal notification preferences, separate from workflow YAML and repository permissions. [Actions notification settings](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications)

Acceptance proposal: record the intended recipient, check those settings, deliberately fail a harmless manual run, and confirm the delivered email references that run. Also confirm delivery from a scheduled failure; a manual dispatch does not establish scheduled routing. Until observed, report notification configuration separately from delivery verification.

Observed during this task: separate read-only inspection of the maintainer workspace confirmed delivery of an earlier manual Release Qualification failure email. Ordinary manual failure delivery is established; scheduled-recipient delivery remains unverified. Private mailbox details are intentionally excluded from this note. A new deliberate manual failure is unnecessary unless recipient/settings change.

## Scheduling and trusted source

Scheduled workflows exist and run on the default branch's latest commit. Cron normally uses UTC; current documentation also supports an explicit IANA timezone. Runs can be delayed and queued runs can be dropped under load, especially near the start of an hour. Changes to the default branch or reactivation can change the scheduled actor. [Scheduled events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

Design inference: use a daily off-hour-boundary schedule, such as the previously proposed `17 2 * * *` UTC. The default-branch orchestrator should read the approved-release pointer once, record its digest, and fetch the pinned source, images, cases and grader. Missing approval should fail clearly before inference. A missing or failed run must leave activation unchanged. A dropped schedule creates no failing run to email; native Actions alone does not guarantee missing-run detection.

Keep provider access limited to the evaluation job. Use minimum `GITHUB_TOKEN` permissions, full commit SHAs for actions, and no untrusted PR checkout in a privileged workflow. Grant the existing ledger/publication operations only the write permissions they require. [GitHub Actions security guidance](https://docs.github.com/en/actions/reference/security/secure-use)

## Durable release evidence

Actions artifacts and logs have finite retention: the default is 90 days, with private repositories configurable up to 400 days subject to higher-level limits. Retention changes affect new objects. They are not a permanent qualification archive. [Retention policy](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization)

Private Release assets are available to repository readers. Each asset must be under 2 GiB; a release supports up to 1,000 assets. Preserve the existing compressed image chunks and manifest verification. [Release access and limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

The asset API supports authenticated download by asset ID, provides SHA-256 digest metadata, and may return either binary content or a redirect. Keep the independently pinned manifest digest authoritative; discovering a replacement asset's digest does not approve replacement contents. [Release asset API](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)

GitHub immutable releases lock assets and their tag after publication and generate a release attestation. GitHub recommends creating a draft, uploading every asset, then publishing. The release title, notes and latest marker remain mutable, so none should be the approved identity. Repository availability/settings were not checked here. [Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)

Design proposal: archive the complete original pilot/confirmation evidence beside the candidate images; retain relative paths, original timestamps and file inventory in a digest-bound archive. Download to a fresh directory and verify before use. Storage retention must not extend this repository's existing qualification expiry. Explicit activation records the verified identity; rollback selects a previously approved compatible identity. Nightly monitoring uses its frozen regression subset and records new evidence without requalifying or promoting it. See the existing [release contract](../releases.md).

## Minimal completion evidence

- A qualified current-view candidate, verified from downloaded private assets.
- Explicit activation and tested rollback, both retaining identity and audit history.
- A scheduled run against the approved identity with the dedicated key and shared accounting.
- A retained failing run and confirmed maintainer email, with runtime activation unchanged.

These are proposed acceptance checks, not completed operations.
