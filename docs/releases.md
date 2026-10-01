# Release evidence verification

This is the first slice of [#11](https://github.com/Mochib-Tech-Solutions/xpathed/issues/11): an offline check of qualification evidence against an exact source revision. It makes no provider calls and leaves the application configuration unchanged.

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

Success means the referenced evidence meets this verification contract. It does not attest a deployed image or authenticate provider execution: someone able to fabricate evidence before sealing could also produce a digest for it. Optional local build fingerprints are observations, not proof of deployed binaries. Signed provenance and durable evidence archives are separate work.

## Current boundary

No retained model currently qualifies. The existing exposed families are regression data; fresh independent held-out families are required before new release qualification. Synthetic positive tests exercise the verifier without qualifying a real model or spending money.

Promotion, rollback, durable release retention and drift notifications remain in #11. Paid scheduled monitoring remains deferred under the no-paid-CI rule. The current environment-selected runtime default stays unchanged; verification alone never creates an approved-release pointer or switches models.

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

Bundle storage is private and local. Image archives can occupy several gigabytes; shared layers affect actual size. They contain no page/provider evidence, so copying a bundle does not extend evidence retention or bypass the evidence verifier's expiry checks. Local storage is not an off-device backup. Keep bundles while needed and remove them explicitly; no automatic image or artifact pruning is added.

No GitHub setup, package registry, new secrets or account upgrade is required. Deterministic CLI tests run in the existing tooling gate; bundle creation and real image roundtrips remain explicit local operations. Branch protection and Copilot verification remain the separate [account follow-up #41](https://github.com/Mochib-Tech-Solutions/xpathed/issues/41). Promotion, exact-image qualification and operational rollback remain in #11.

The [Docker/Git research notes](research/2026-10-01-private-release-bundles.md) explain tag-free image export, archive identity and platform limits.
