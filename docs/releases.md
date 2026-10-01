# Release evidence verification

Release tooling for [#11](https://github.com/Mochib-Tech-Solutions/xpathed/issues/11) verifies evidence, preserves candidate images, and explicitly evaluates those exact images. Offline verification makes no provider calls; live evaluation remains explicitly authorized and uses provider key limits. Verification and monitoring leave the application unchanged. Promotion selects an approval, and explicit activation deploys its exact images.

## Seal and verify

Use a clean checkout at the revision that produced the evidence. Supply the original live development pilot, its live confirmation run and the selected profile from `evaluation/qualification-profiles.json`:

```sh
mkdir -p -m 700 .artifacts/releases
pnpm release:seal --confirmation .artifacts/evaluation/confirmation \
  --pilot .artifacts/evaluation/pilot --profile PROFILE_ID \
  --source-sha FULL_COMMIT_SHA --suite evaluation/current-view-qualification-cases.json \
  --output .artifacts/releases/candidate.json
pnpm release:verify .artifacts/releases/candidate.json --sha256 EXPECTED_SHA256
```

Retain the SHA-256 printed by sealing independently of the candidate and evidence files. Verification checks that caller-supplied digest before following candidate references. Recomputing a digest from a changed candidate would discard this protection. Candidate output is private and exclusive: an existing file is never overwritten.

The seal references existing local evidence instead of copying it. Preserve its paths while it remains eligible. Verification fails when referenced files change, disappear or pass their original evidence retention deadline; sealing does not restart the retention clock. Keep these artifacts out of Git and public CI uploads.

## What passes

Both commands require the actual clean Git checkout and source fingerprints to match the candidate. The confirmation must cover the current reviewed eligible cases and required splits under the frozen policy. The verifier checks original trial identities and completeness, configuration and profile settings, browser identity, the linked pilot and its recomputed baseline, and the selected confirmation profile's recomputed qualification result. A saved passing summary is not approval. Missing, malformed, altered, incomplete, expired or unqualified evidence returns a nonzero exit code.

Success means the referenced evidence meets this verification contract. Without the optional bundle flags below, it does not attest a deployed image. Neither form authenticates provider execution: someone able to fabricate evidence before sealing could also produce a digest for it. Optional local build fingerprints are observations, not proof of deployed binaries. Signed provenance remains separate work; portable evidence archives are described below.

## Current boundary

A model must pass real qualification before the first approval. Policy 3 uses the reviewed current-view suite and exact source/artifact identity. Existing exposed cases remain development/regression evidence; new held-out families are reserved in private `release-state` by the shared evaluator before any confirmation inference, including local CLI runs. Initialize this authority before a policy-3 live confirmation. Failed or interrupted reservations cannot be reused as fresh qualification. Synthetic verifier tests do not qualify a real model.

Legacy policy 2 remains unchanged. Policy 3 explicitly requires contract 4, prompt 8, capture 5 and current-view scope; legacy-only evidence cannot qualify the client default. Each policy is frozen with its suite and source before held-out inference.

Approval, activation and monitoring follow [ADR-0021](adr/0021-monitor-explicitly-approved-current-view-releases.md). A failed qualification leaves the existing application available and produces no approval. Verification alone never switches models.

## Private Docker artifact bundles

Bundles preserve the exact Browser and Resolver runtime images for a selected profile. They are **packaged, unqualified artifacts**: successful creation, verification or restoration does not establish model quality or connect historical qualification evidence to these images. The existing evidence seal cannot prove which Docker images produced an older run.

Create a bundle from a clean checkout at its exact commit. Docker must be running on a local Unix-socket endpoint; remote contexts are rejected and builds use that daemon's default builder. Builds may download pinned base images and build dependencies. Creation builds from a tracked-source archive, so untracked local `.env`, ignored files, browser data and database volumes are excluded. This does not sanitize secrets already committed to Git. It records nonsecret profile settings without copying runtime credentials. Keep credentials separate when a later deployment workflow uses these artifacts.

```sh
mkdir -p -m 700 .artifacts/releases
pnpm release:bundle --profile deepseek --source-sha FULL_COMMIT_SHA \
  --output .artifacts/releases/my-bundle
pnpm release:bundle:verify .artifacts/releases/my-bundle --sha256 EXPECTED_MANIFEST_SHA256
pnpm release:bundle:restore .artifacts/releases/my-bundle --sha256 EXPECTED_MANIFEST_SHA256
```

Retain the printed manifest digest separately. The bundle contains the source archive, Docker image archive, configuration and manifest. Existing output directories are never overwritten. Verification checks the externally pinned manifest digest before reading bundle contents, requires the exact inventory and matching file hashes, and rejects unsupported formats and unsafe paths. Archives are hashed as streams rather than loaded into memory. Verification uses local Git/tar tools and needs neither Docker nor the original checkout revision.

Restoration verifies the bundle before loading its images into Docker, then checks their immutable IDs and platform. It supports the recorded Linux architecture and does not start containers, update application tags, change defaults or access a registry. Docker image stores can represent IDs differently, so cross-store restoration is not guaranteed; mismatched IDs fail rather than being treated as equivalent. It restores Browser/Resolver images only, not Web, ClientApi or database state. Keep the bundle unchanged during verification/restoration. A digest provides integrity relative to a trusted copy; it is not a signature or independent proof of a build.

Local bundle storage is private; the manual GitHub workflow also preserves bundles as private Release assets. Image archives can occupy several gigabytes; shared layers affect actual size. They contain no page/provider evidence, so copying a bundle does not extend evidence retention or bypass the evidence verifier's expiry checks. Local storage is not an off-device backup. Keep bundles while needed and remove them explicitly; no automatic image or artifact pruning is added.

Local bundle commands need no GitHub setup, package registry, new secret or account upgrade. Deterministic CLI tests run in the existing tooling gate; remote execution uses the explicit manual workflow below. Branch protection and Copilot verification remain the separate [account follow-up #41](https://github.com/Mochib-Tech-Solutions/xpathed/issues/41). Successful real-model qualification and operational receipts are required before claiming release completion.

The [Docker/Git research notes](research/2026-10-01-private-release-bundles.md) explain tag-free image export, archive identity and platform limits.

## Evaluate saved images

Use the bundle's exact clean source checkout and one matching profile. The wrapper verifies and restores the images, creates an isolated Compose project, and starts only Browser, the selected Resolver and the pinned fixture. Runtime images use full IDs with building and pulling disabled; setup may download the separately pinned fixture image. Container image and ownership checks run before and after evaluation; replacement containers, mismatched images and cleanup failures fail the run.

```sh
pnpm release:evaluate --bundle .artifacts/releases/my-bundle --sha256 EXPECTED_MANIFEST_SHA256 \
  --mode deterministic --profile deepseek --split development,regression \
  --output .artifacts/evaluation/bundle-check
```

Live pilot and confirmation use the same command with `--mode live`, the complete respective splits, and a recorded `--pilot` for confirmation. Preserve one attempt per case. The artifact identity in both manifests must match; rebuilding even from the same source creates a different candidate when image IDs differ.

To seal image-bound live qualification evidence, add `--bundle DIRECTORY --bundle-sha256 DIGEST` to `release:seal`. It verifies both runs' pre/post container receipts against the bundle and records `artifact-bound-evidence-verified`. Omitting the bundle cannot downgrade artifact-bearing evidence to the legacy seal. The original evidence expiry still applies. These observations are integrity checks, not signed attestation or automatic promotion.

## Manual GitHub qualification

The **Release Qualification** Actions workflow accepts a maintainer manual dispatch from `main` or a `release/NAME` branch with a successful CI aggregate at the exact source SHA, checks out the exact dispatched SHA, and supports one selected profile:

- `preflight`: read the authoritative ledger and OpenRouter key metadata, report cost accounting, key metadata and qualification coverage; no inference or image build.
- `deterministic`: build and preserve a candidate, then exercise its exact images with controlled responses; no provider key or inference.
- `live`: require fresh reviewed held-out coverage and no declared capability gaps before building or billing. Run the complete current-view development pilot, require every pilot case correct and complete with the frozen latency gate, then run confirmation under policy 3, then require successful artifact-bound sealing. An unqualified model fails this workflow even when the measurement itself completed.

Preflight verifies reviewed coverage and previous family exposure before inference. Passing preflight verifies setup, not model quality. Release branches use the same exact-revision CI, private-repository and maintainer gates as main. Deterministic authored fixtures are engineering evidence, not original dataset model-quality scores.

Set the repository Actions secret `OPENROUTER_EVAL_API_KEY` to an ordinary dedicated inference key. Its configured provider-side limit is the spending control; the workflow adds no local monetary ceiling. The workflow passes that secret as `OPENROUTER_EVAL_API_KEY`, matching local evaluation configuration. The workflow reads `/api/v1/key` and reports configured limits without imposing a cap/reset/balance policy; invalid, expired or management credentials remain rejected. Do not put a management key, personal GitHub token, local `.env` or runtime application key in this workflow. GitHub's job token supplies repository contents access; only the evaluation fixture's proxy receives credentials. Standard routes, original attempts and durable per-request accounting remain enforced. Historical hosted policy-2 qualification end-to-end latency includes both durable GitHub accounting writes. Provider records expose their reservation/reconciliation `remoteAccountingMs` separately, without subtracting them from qualification latency or weakening the 1s/2s policy. These measurements describe the hosted execution path, not model-only latency; the separate current-view development baseline uses the pre-reserved timing protocol below and cannot qualify a release under this hosted contract.

The current-view paired baseline records `resolver-http-pre-reserved-v2`: record each frozen request estimate durably before starting resolution; validate the actual request identity; return the validated provider response before the remote reconciliation write. Await reconciliation and retained evidence before another attempt or reporting. A failed durable write or invalid identity halts the run; unknown costs and unused estimates remain explicit without a money-based continuation block. This isolates evaluation bookkeeping from Resolver HTTP timing; the application has no two-second total-response cutoff. The original inline-accounting run remains failed evidence; no overhead is subtracted retrospectively. Policy 3 explicitly adopts this protocol for new release evidence, retaining every original attempt and binding each live request to its prepared payload.

Before enabling hosted spending, migrate the existing `.artifacts/datasets/experiment-budget.json` intact to `experiment-budget.json` on the private `evaluation-budget` branch. Preserve the historical ceiling, entries and reservation reviews, record `budgetPolicy: "provider-limit"`, and add `remoteAuthority: "github:mochib-tech-solutions/xpathed:evaluation-budget:experiment-budget.json"`. Verify the remote content before marking the local copy with the identical authority. Keep an independent private backup. Never bootstrap a fresh empty campaign, run an older checkout against a pre-migration ledger, delete pending charges, or reset the ledger on a rerun.

Hosted calls set `XPATHED_BUDGET_GITHUB_REPOSITORY` and `GH_TOKEN`. The shared proxy requires the existing authoritative file, reserves through a conditional GitHub update before inference and reconciles afterward. Concurrent updates and persistence failures block further calls; unknown charges remain recorded without blocking solely on financial grounds. A cancelled runner therefore leaves its reservation visible. A marked local copy refuses independent spending; explicitly configured local callers use the same authority. New runs use the `provider-limit` policy from [ADR-0019](adr/0019-use-provider-key-limits-for-evaluation.md): preserve all ledger entries and historical ceilings, but rely on the configured key limit instead of a local spending ceiling. The separate application key is unrelated. GitHub Actions minutes/storage have their own account budget.

Private candidate Release assets retain the bundle files plus the independently recorded manifest digest. Image archives use gzip transport split into numbered chunks of at most 1,000,000,000 bytes, safely below GitHub's per-asset limit even when compression is ineffective. In a private transport directory, reconstruct with `cat images.tar.gz.part-* | gzip -d > ../bundle/images.tar`, then verify against the original manifest digest. Missing, reordered or altered chunks cannot pass the original image-archive hash. Keep only the four original bundle files in the bundle directory, with the retained digest separately. Publication first creates a draft and publishes only after all assets upload. The fixture runs as the invoking host UID/GID so private evidence remains readable by the uploader on Linux. Assets remain unapproved candidates and are never silently substituted with latest. Private evaluation artifacts retain original failures and evidence for 30 days; Release assets do not extend that evidence deadline. Promotion retains the previous approved release. Publication or upload failure remains a workflow failure.

The hosted runner uses Linux ARM64. Validate its Docker image-store identity and browser sandbox with `deterministic` before enabling live runs. The workflow does not connect to or update the local application. The separately authorized nightly workflow below uses the evaluation key. No workflow automatically changes the approved default.

## Portable evidence and explicit approval

Version-2 seals use paths under the exact checkout's `.artifacts/` directory. `pnpm release:archive CANDIDATE --sha256 DIGEST OUTPUT` preserves the candidate and every referenced evidence file in a private compressed archive. `pnpm release:archive:restore ARCHIVE --sha256 DIGEST` requires the exact source checkout and restored bundle, rejects unsafe paths/altered inventories and re-verifies the original evidence. It never overwrites existing files. Qualification publishes `release-evidence.json.gz` and `candidate-sha256.txt` alongside the private candidate images. Retain the candidate digest independently before approving it.

Archives preserve the original thirty-day evidence expiry. Private release assets are operator-owned; remove expired page/provider evidence archives under the existing retention policy, retaining nonsecret source/image identities and approval history separately. Archived bytes do not create permanent qualification eligibility. Monitoring fails explicitly if required evidence expires or disappears.

Initialize or inspect the private authoritative approval state:

```sh
pnpm release:state init
pnpm release:state status
```

Select a candidate explicitly through **Release Promotion** or the CLI:

```sh
pnpm release:promote --tag candidate-RUN-ATTEMPT --sha256 CANDIDATE_DIGEST \
  --expected-current none --reason "Reviewed exact-image qualification"
pnpm release:activate --expected-current CANDIDATE_DIGEST
```

Later promotions require the current approved digest instead of `none`. Approval downloads and verifies the exact source, image archive and qualification evidence, and checks the frozen sentinels against their measured baseline. It uses conditional state writes, records the actor/reason and retains the previous approval. Missing qualification, incompatible contracts, stale evidence, altered assets and concurrent updates fail before selection. There is no implicit `latest` choice.

Local activation refuses another checkout's Compose project or an active development configuration. Stop this checkout's development runner first. Activation uses the verified Browser/Resolver image IDs and nonsecret settings while retaining the application's API key and database volumes. It restarts browser sessions and records actual image/container identity in `.artifacts/releases/deployment.json`. A failed activation is recorded as failed; it never claims the selected approval is already running. The GitHub promotion workflow cannot deploy into a maintainer's local Docker daemon.

Rollback is explicit and requires a still-verifiable previous compatible approval:

```sh
pnpm release:rollback --expected-current CURRENT_DIGEST --reason "Regression investigation"
pnpm release:activate --expected-current PREVIOUS_DIGEST
```

Rollback preserves the displaced approval in the audit. Restoring code/images cannot restore a provider's historical model weights. A first deployment has no qualified predecessor; synthetic rollback tests do not establish an observed real rollback.

## Nightly monitoring and notification checks

**Release Monitoring** runs at 02:17 UTC (03:17 Tunisia) and supports manual dispatch. It shares `paid-evaluation` concurrency with qualification/promotion and uses only `OPENROUTER_EVAL_API_KEY`. Its main-branch orchestrator reads the approved pointer, restores the exact recorded source and images, and executes the frozen sentinel list with the recorded grader, policy and one attempt per case. It does not rebuild latest development code. No approved release means a failed check with no inference, never a substitute model.

Semantic drift, latency regression and infrastructure failures remain distinct in `monitoring.json`. Every failure fails CI and retains private original evidence for thirty days. `release:state status` reports the last started/completed check and approved identity; monitoring never changes approval, activation or the running application. Investigate the recorded run, provider accounting and missing assets before explicitly promoting or rolling back.

Run `pnpm release:monitor` locally for the same live check. Use the workflow's `notification_test` input (or `pnpm release:monitor --notification-test`) for a controlled failure that makes no provider calls and leaves approval unchanged. Confirm the corresponding failure email and the first real scheduled failure separately. Existing manual GitHub failure emails were observed during setup; administrator status alone is not delivery evidence.

GitHub schedules can be delayed or dropped, and email follows the account's notification preferences and schedule actor. The recorded last-completed time exposes a missed run; native Actions email cannot alert for a run that never started. The [research note](research/2026-10-01-release-monitoring-setup.md) links the official notification and scheduling behavior. Do not claim scheduled delivery before observing it.

Sentinels use only development/regression families. The shared evaluator rejects held-out sentinel membership, so an early local monitoring run cannot consume fresh qualification families.
