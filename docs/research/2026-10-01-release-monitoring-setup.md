# Release monitoring setup

Checked 2026-10-01 against official GitHub documentation for #11. The initial research below preceded setup; the dated verification section records the later observed results. The current user request authorizes recurring monitoring with `OPENROUTER_EVAL_API_KEY`; ADR-0021 records the implemented authorization.

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

## Setup verification — 2026-10-01

Implementation merged in [PR #64](https://github.com/Mochib-Tech-Solutions/xpathed/pull/64), source `ec852f4c714bd28a3a995456a1d8e9cb73609986`. [Merged-main CI](https://github.com/Mochib-Tech-Solutions/xpathed/actions/runs/36931535236) passed. The schedule is enabled at 02:17 UTC (03:17 Tunisia), uses `OPENROUTER_EVAL_API_KEY`, and records approval and monitoring state on the private `release-state` branch. No release is approved.

[Hosted preflight](https://github.com/Mochib-Tech-Solutions/xpathed/actions/runs/36931555935) verified the dedicated evaluation credential and fresh coverage: thirty held-out cases in ten families. The key expires on 2026-10-31 at 11:22 UTC. Rotation must update the evaluation secret before then. Provider key limits remain authoritative; historical unknown charges were preserved.

The [controlled manual monitoring failure](https://github.com/Mochib-Tech-Solutions/xpathed/actions/runs/36931557780) produced an email whose body referenced that exact run. Read-only mailbox inspection confirmed delivery; no account setting was changed. Private recipient details remain excluded. Scheduled delivery has not yet been observed.

The [normal monitoring run](https://github.com/Mochib-Tech-Solutions/xpathed/actions/runs/36934072634), with the test flag false, failed explicitly because no approved release exists. It made no inference calls and did not substitute the running default. Approval history and all five local container/image identities remained unchanged. Web/ClientApi contract checks, database connectivity, Browser and Resolver HTTP health passed afterward. The normal result is retained as the last completed monitoring run.

### Qualification pilots

Each row contains one live attempt per development case. These five-case pilots cannot qualify a release. Reported costs include failures; no charge in these runs is unresolved. Local timings and hosted timings are separate observations, not a controlled route comparison.

| Profile and configuration                  | Environment                  | Correct | Correct within 2 s | p50 / p95, ms | Reported USD |
| ------------------------------------------ | ---------------------------- | ------: | -----------------: | ------------: | -----------: |
| DeepSeek/Wafer, prompt 8                   | Hosted exact-image candidate |     3/5 |                3/5 |   1093 / 1295 |  0.000398256 |
| DeepSeek/Wafer, experimental prompt 9      | Local development            |     3/5 |                3/5 |    945 / 1192 |  0.000431408 |
| Gemini/Google AI Studio, existing prompt 8 | Local development            |     5/5 |                3/5 |   1838 / 2927 |  0.006375750 |
| Qwen/Alibaba, existing prompt 8            | Local development            |     3/5 |                1/5 |   2743 / 4146 |  0.000698488 |

The [hosted DeepSeek pilot](https://github.com/Mochib-Tech-Solutions/xpathed/actions/runs/36932485483) returned found targets for a sequential command and invalid per-target actions for a mixed command. The stricter experimental prompt placed whole-command rejection before enumeration, but retained both failures; it was reverted without merging. Its private diff and original request/response evidence remain saved. Gemini classified all five commands correctly, but absence and mixed-command responses exceeded two seconds. Qwen repeated the two semantic failures and exceeded the latency gate. Total reported cost across these twenty calls was **$0.007903902**.

All runs stopped before held-out confirmation. The authoritative exposure inventory remains empty, so the thirty held-out cases remain fresh. No threshold, expected label or qualification result was relaxed. The application continues to use its existing DeepSeek/Wafer configuration, which is operational but unqualified.

Private evidence directories and manifest IDs:

- `.artifacts/releases/live-36932485483/pilot`: `5e8a34c8-240f-4c70-8c55-00e22f9c96a4`.
- `.artifacts/evaluation/prompt9-development`: `67a23641-7482-442f-9931-3533562b07cd`.
- `.artifacts/evaluation/gemini-current-view-development`: `c2ae64ef-fce2-4977-95ea-eb7dadd3083e`.
- `.artifacts/evaluation/qwen-current-view-development`: `99bc70fb-4b81-46a0-aa70-cd3e5edd5b20`.

The failed hosted candidate remains available as private Release assets under `candidate-36932485483-1`, with bundle manifest SHA-256 `fa0262298683b3fd80215515c87c60a02fe5ea20823e4379ea189d0cd14e7c34`. Packaging does not establish qualification. Apply the existing evidence retention policy to all private runs.

### Remaining evidence for issue #11

A candidate must first pass the unchanged development gate, then full exact-image regression and fresh held-out qualification. Until that happens, there is no valid candidate to promote, activate or monitor for model drift. Real rollback also needs a retained qualified predecessor; synthetic rollback checks already cover the implementation boundary. The first scheduled run and its notification delivery remain unobserved. These requirements keep #11 open despite the completed setup.

## First approved release — 2026-10-02

The maintainer accepted temporary policy 7: overall correctness must match or exceed the baseline, every individual gain/lost pass remains visible, and latency is descriptive. Safety, provider accounting, complete evidence and exact artifact identity remain mandatory. Preserving each individual baseline pass is intended for a later policy version. Historical qualification outcomes retain their original policies.

[Qualification run 37007941576](https://github.com/Mochib-Tech-Solutions/xpathed/actions/runs/37007941576) passed on source `86d8937d97e312be83fca5c626111dacd58225c4`, following successful exact-revision [main CI](https://github.com/Mochib-Tech-Solutions/xpathed/actions/runs/37006721334). The candidate uses DeepSeek V4.1 Flash through Wafer, reasoning disabled, maximum output 4,096 tokens, contract 4, prompt 10, capture 5 and XPath strategy 4. Both candidate and pinned bootstrap images were verified before comparison; every original attempt is retained.

| Phase        | Arm                | Correct | Median, ms | p95, ms |
| ------------ | ------------------ | ------: | ---------: | ------: |
| Pilot        | Candidate          |     3/5 |     1367.0 |  1961.6 |
| Pilot        | Bootstrap baseline |     3/5 |     1822.7 |  2197.2 |
| Confirmation | Candidate          | 119/135 |     1116.9 |  1710.2 |
| Confirmation | Bootstrap baseline | 105/135 |      856.8 |  1894.4 |

Confirmation improved by 14 passing cases overall: 15 gains and one lost baseline pass. In `release3-listbox-1`, the candidate found the correct Greek option but interpreted `click` as `select`, changing the readiness assessment. The two pilot failures and sixteen confirmation failures remain recorded. These authored browser fixtures do not establish production accuracy or statistically significant speed differences. Of all confirmation cases, 117/135 were correct and complete within two seconds; speed did not determine qualification.

All 280 calls across both arms reconciled, with **$0.02556002 USD** reported and **zero unknown charges in this run**. Historical unknown ledger entries remain preserved separately. The downloaded original confirmation evidence replayed to the same qualified result. The thirty newly exposed cases in ten families cannot count as fresh held-out coverage for another qualification.

[Explicit promotion 37013033372](https://github.com/Mochib-Tech-Solutions/xpathed/actions/runs/37013033372) downloaded and verified the unchanged candidate assets, then selected [v1.0.0](https://github.com/Mochib-Tech-Solutions/xpathed/releases/tag/v1.0.0) in authoritative approval state. The original `v1.0.0-rc.6` Git tag remains at the same source. Verified identities:

- Candidate: `4bbb4040984368a85f2c20e3e33d25547cc289975729467e2b4d2d9fa9860e92`.
- Bundle: `23c6ed2b4969951e5fd45b9e841ed2ef837eaaea9dd7cfceafe723a4e22cc4f2`.
- Evidence archive: `29ca5867ede541f98998fd37b68969627244fb3c969641f223ca4b5d2ada2446`.

The approval freezes fifteen sentinel cases and their original measurements; its monitoring receipt permits nightly verification after the thirty-day qualification archive expires. New promotions still require fresh qualification. Local evidence is retained under `.artifacts/release-live-37007941576/`.

### Approved-release monitoring and cleanup

[Monitoring run 37013255851](https://github.com/Mochib-Tech-Solutions/xpathed/actions/runs/37013255851) passed against the exact approved images: 12/15 correct, matching the frozen baseline, with no gains or lost passes. The three known failures remain visible. Median latency was 1,057.9 ms and p95 was 1,578.6 ms. All fifteen calls reconciled for **$0.00128837 USD**, with no unknown charges. The authoritative last-completed record agrees with the downloaded evidence and retains the same approved candidate digest. This manual run verifies approved-artifact execution; the first scheduled run against this approved release is still pending.

After approval and asset verification, the eight older unapproved Release objects were deleted at the maintainer's request. Their Git tags and local diagnostic evidence were retained. `v1.0.0` is the sole published Release; its assets are unchanged.

### Scheduled failure delivery

[Scheduled monitoring run 36956795982](https://github.com/Mochib-Tech-Solutions/xpathed/actions/runs/36956795982) started at 02:41:33 UTC on 2026-10-02, after the nominal 02:17 schedule. It failed explicitly because no release was approved at that time, made no inference calls and left the runtime unchanged. Read-only mailbox inspection confirmed a delivered failure email that links to this exact scheduled run. Manual and scheduled failure-email delivery are now observed. This does not guarantee delivery for a schedule GitHub never starts. Private recipient details are excluded.

### Remaining operational scope

Approval has not activated these images in the local development stack. Local activation restarts browser sessions and records deployment identity separately. A first approved release has no qualified predecessor for a real operational rollback; deterministic rollback boundary tests remain the current evidence. Issue #11 stays open for those operational checks.
