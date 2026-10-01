# Release evidence verification

Release tooling for [#11](https://github.com/Mochib-Tech-Solutions/xpathed/issues/11) verifies evidence, preserves candidate images, and explicitly evaluates those exact images. Offline verification makes no provider calls; live evaluation remains explicitly authorized and uses provider key limits. All commands leave the application default unchanged.

## Seal and verify

Use a clean checkout at the revision that produced the evidence. Supply the original live development pilot, its live confirmation run and the selected profile from `evaluation/qualification-profiles.json`:

```sh
mkdir -p -m 700 .artifacts/releases
pnpm release:seal --confirmation .artifacts/evaluation/confirmation \
  --pilot .artifacts/evaluation/pilot --profile PROFILE_ID \
  --source-sha FULL_COMMIT_SHA --output .artifacts/releases/candidate.json
pnpm release:verify .artifacts/releases/candidate.json --sha256 EXPECTED_SHA256
```

Retain the SHA-256 printed by sealing independently of the candidate and evidence files. Verification checks that caller-supplied digest before following candidate references. Recomputing a digest from a changed candidate would discard this protection. Candidate output is private and exclusive: an existing file is never overwritten.

The seal references existing local evidence instead of copying it. Preserve its paths while it remains eligible. Verification fails when referenced files change, disappear or pass their original evidence retention deadline; sealing does not restart the retention clock. Keep these artifacts out of Git and public CI uploads.

## What passes

Both commands require the actual clean Git checkout and source fingerprints to match the candidate. The confirmation must cover the current reviewed eligible cases and required splits under the frozen policy. The verifier checks original trial identities and completeness, configuration and profile settings, browser identity, the linked pilot and its recomputed baseline, and the selected confirmation profile's recomputed qualification result. A saved passing summary is not approval. Missing, malformed, altered, incomplete, expired or unqualified evidence returns a nonzero exit code.

Success means the referenced evidence meets this verification contract. Without the optional bundle flags below, it does not attest a deployed image. Neither form authenticates provider execution: someone able to fabricate evidence before sealing could also produce a digest for it. Optional local build fingerprints are observations, not proof of deployed binaries. Signed provenance and durable evidence archives are separate work.

## Current boundary

No retained model currently qualifies. The existing exposed families are regression data; fresh independent held-out families with explicitly versioned current-view coverage are required before new release qualification. The contract-4 baseline is development evidence, not a qualifying replacement for the legacy contract-3 suite. Synthetic positive tests exercise the verifier without qualifying a real model or spending money.

Promotion, operational rollback and drift notifications remain in #11. Paid scheduled monitoring remains deferred; only manually dispatched qualification is authorized. The current environment-selected runtime default stays unchanged; verification alone never creates an approved-release pointer or switches models.

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

Local bundle commands need no GitHub setup, package registry, new secret or account upgrade. Deterministic CLI tests run in the existing tooling gate; remote execution uses the explicit manual workflow below. Branch protection and Copilot verification remain the separate [account follow-up #41](https://github.com/Mochib-Tech-Solutions/xpathed/issues/41). Successful real-model qualification, promotion and operational rollback remain in #11.

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

The **Release Qualification** Actions workflow accepts only a manual dispatch from `main`, checks out the exact dispatched SHA, and supports one selected profile:

- `preflight`: read the authoritative ledger and OpenRouter key metadata, report cost accounting, key metadata and qualification coverage; no inference or image build.
- `deterministic`: build and preserve a candidate, then exercise its exact images with controlled responses; no provider key or inference.
- `live`: require fresh reviewed held-out coverage and no declared capability gaps before building or billing. Run a complete development pilot and confirmation under the existing policy, then require successful artifact-bound sealing. An unqualified model fails this workflow even when the measurement itself completed.

The current exposed cases do not meet fresh held-out requirements. Preflight success verifies setup, not release readiness. This first hosted path accepts reviewed default-branch source; arbitrary release-branch dispatch, approved-default selection, rollback activation and scheduled monitoring remain separate work. Deterministic authored fixtures are engineering evidence, not original dataset model-quality scores.

Set the repository Actions secret `OPENROUTER_EVAL_API_KEY` to an ordinary dedicated inference key. Its configured provider-side limit is the spending control; the workflow adds no local monetary ceiling. The workflow passes that secret as `OPENROUTER_EVAL_API_KEY`, matching local evaluation configuration. The workflow reads `/api/v1/key` and reports configured limits without imposing a cap/reset/balance policy; invalid, expired or management credentials remain rejected. Do not put a management key, personal GitHub token, local `.env` or runtime application key in this workflow. GitHub's job token supplies repository contents access; only the evaluation fixture's proxy receives credentials. Standard routes, original attempts and durable per-request accounting remain enforced. General hosted qualification end-to-end latency includes both durable GitHub accounting writes. Provider records expose their reservation/reconciliation `remoteAccountingMs` separately, without subtracting them from qualification latency or weakening the 1s/2s policy. These measurements describe the hosted execution path, not model-only latency; the separate current-view development baseline uses the pre-reserved timing protocol below and cannot qualify a release under this hosted contract.

The current-view paired baseline records `resolver-http-pre-reserved-v2`: record each frozen request estimate durably before starting resolution; validate the actual request identity; return the validated provider response before the remote reconciliation write. Await reconciliation and retained evidence before another attempt or reporting. A failed durable write or invalid identity halts the run; unknown costs and unused estimates remain explicit without a money-based continuation block. This isolates evaluation bookkeeping from the application's unchanged two-second deadline. The original inline-accounting run remains failed evidence; no overhead is subtracted retrospectively. This development protocol does not change release qualification policy.

Before enabling hosted spending, migrate the existing `.artifacts/datasets/experiment-budget.json` intact to `experiment-budget.json` on the private `evaluation-budget` branch. Preserve the historical ceiling, entries and reservation reviews, record `budgetPolicy: "provider-limit"`, and add `remoteAuthority: "github:mochib-tech-solutions/xpathed:evaluation-budget:experiment-budget.json"`. Verify the remote content before marking the local copy with the identical authority. Keep an independent private backup. Never bootstrap a fresh empty campaign, run an older checkout against a pre-migration ledger, delete pending charges, or reset the ledger on a rerun.

Hosted calls set `XPATHED_BUDGET_GITHUB_REPOSITORY` and `GH_TOKEN`. The shared proxy requires the existing authoritative file, reserves through a conditional GitHub update before inference and reconciles afterward. Concurrent updates and persistence failures block further calls; unknown charges remain recorded without blocking solely on financial grounds. A cancelled runner therefore leaves its reservation visible. A marked local copy refuses independent spending; explicitly configured local callers use the same authority. New runs use the `provider-limit` policy from [ADR-0019](adr/0019-use-provider-key-limits-for-evaluation.md): preserve all ledger entries and historical ceilings, but rely on the configured key limit instead of a local spending ceiling. The separate application key is unrelated. GitHub Actions minutes/storage have their own account budget.

Private candidate Release assets retain the bundle files plus the independently recorded manifest digest. Image archives use gzip transport split into numbered chunks of at most 1,000,000,000 bytes, safely below GitHub's per-asset limit even when compression is ineffective. In a private transport directory, reconstruct with `cat images.tar.gz.part-* | gzip -d > ../bundle/images.tar`, then verify against the original manifest digest. Missing, reordered or altered chunks cannot pass the original image-archive hash. Keep only the four original bundle files in the bundle directory, with the retained digest separately. Publication first creates a draft and publishes only after all assets upload. The fixture runs as the invoking host UID/GID so private evidence remains readable by the uploader on Linux. Assets remain unapproved candidates and are never silently substituted with latest. Private evaluation artifacts retain original failures and evidence for 30 days; Release assets do not extend that evidence deadline. Keep the previous approved release when promotion is later implemented. Publication or upload failure remains a workflow failure.

The hosted runner uses Linux ARM64. Validate its Docker image-store identity and browser sandbox with `deterministic` before enabling live runs. The workflow does not connect to or update the local application. No cron, recurring provider allowance, notification-delivery claim or automatic default change is introduced.
