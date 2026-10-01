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
