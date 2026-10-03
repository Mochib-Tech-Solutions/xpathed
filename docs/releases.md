# Release workflow

The release flow is **feature PR → main → release PR → live comparison → merge and verified approval → explicit activation**. [ADR-0023](adr/0023-simplify-release-evaluation.md) records the accepted decision. Approval and activation are separate: a passing comparison approves exact images; activation starts them in the local workspace.

## Prepare the repository

Keep a persistent `release` branch for release PRs from `main`. Feature PRs continue targeting `main` and run ordinary CI. Changes to main do not replace the approved baseline.

Configure the dedicated `OPENROUTER_EVAL_API_KEY` Actions secret and preserve private release state and existing approved assets. The checked-in private dataset manifest pins the required reviewed collection. The private `evaluation-data/reviewed-72d140c1.json.gz` asset is published and its downloaded bytes were verified against the pinned digest. See [dataset collection setup](evaluation.md#private-dataset-collection).

Release Qualification, Release Promotion and scheduled monitoring currently require a **private repository**. Making the repository public skips those jobs; release-state operations also reject public repositories. Public operation needs a separate design for private evidence and workflow access.

Workflow files describe checks, not enforced branch protection. Verify the account's ability to require CI and release checks separately. Even if a PR is manually merged without passing checks, promotion must reject it rather than replacing the approval.

## Compare a release PR

Open a trusted same-repository PR from `main` into `release`. Opening, updating, reopening or marking it ready triggers **Release Qualification**. Drafts and other source branches do not qualify.

The workflow:

1. Requires passing ordinary CI for the exact evaluated PR revision.
2. Freezes the approved baseline, candidate images, current policy and complete reviewed collection.
3. Runs one candidate and one baseline attempt per case, including browser resolution and reviewed offline dataset selection. Browser state resets independently.
4. Reports every original outcome, gains, lost passes, latency, costs and exclusions. Browser and offline denominators remain separate.
5. Verifies complete evidence and preserves the exact candidate image bundle and approval request.

Acceptance requires **no lost baseline pass**, plus valid contracts, safety, complete results and verified artifact identity. Equal results can pass. Latency and cost are informational, including unknown charges and unavailable billing metadata. Actual provider failures remain operational failures. There is no separate pilot or mandatory fresh held-out stage. Both arms use the same evaluation set; additions and better checks apply to both arms. A regression is a lost baseline pass in this comparison.

The comparison does not redeploy the app. A failed run retains its evidence and leaves the existing approval unchanged. A new source tree, changed cases or changed baseline requires another complete comparison; old passing evidence cannot qualify a changed candidate.

## Merge and approve

Merging the release PR requests approval of the saved tested candidate. **Release Promotion** checks that:

- The latest matching release comparison succeeded and ordinary CI passed for its exact revision.
- The PR head and final merged source tree match the recorded candidate.
- The baseline used in the comparison is still the approved release.
- The preserved images, configuration, datasets and qualification evidence match their pinned identities.

GitHub's temporary PR merge commit can differ from the final merge commit even when their source trees are equal. Preserve those identities and verify tree equality; do not rebuild images and assume the replacement bytes were tested. Promotion selects the tested images and retains the previous approval. If verification fails after merge, the old approval remains in effect and the failed promotion needs investigation.

The authoritative approval record determines the baseline. A branch, tag, uploaded bundle or green measurement alone is not approval.

## Activate or roll back locally

GitHub approval does not deploy into the maintainer's local Docker daemon. Inspect the selection and activate it explicitly:

```sh
pnpm release:state status
pnpm release:activate --expected-current APPROVED_CANDIDATE_DIGEST
```

Activation verifies approved artifacts and the local Compose project's ownership, preserves the application credentials, and records actual container/image identities. Stop this checkout's development runner first. Browser sessions restart. A failed activation remains a failed deployment, even when approval succeeded.

Rollback explicitly selects the retained compatible previous approval and then activates it:

```sh
pnpm release:rollback --expected-current CURRENT_DIGEST --reason "Regression investigation"
pnpm release:activate --expected-current PREVIOUS_DIGEST
```

Restoring images cannot restore a hosted provider's historical weights. Keep current and previous approved artifacts available and verifiable.

## Artifacts and evidence

Release helpers live in `scripts/release/`. A bundle contains tracked source, exact Browser/Resolver images, nonsecret configuration and an integrity manifest. Credentials, local environment files and user browsing state are excluded. Resolver qualification does not attest separately built Web or ClientApi images.

Local packaging and inspection remain available:

```sh
pnpm release:bundle --profile deepseek --source-sha FULL_COMMIT_SHA --output NEW_BUNDLE_DIRECTORY
pnpm release:bundle:verify BUNDLE_DIRECTORY --sha256 PINNED_MANIFEST_DIGEST
pnpm release:bundle:restore BUNDLE_DIRECTORY --sha256 PINNED_MANIFEST_DIGEST
```

Create from a clean exact checkout. Verification requires an independently retained manifest digest. Restoration loads images without starting the application. The manifest checks image IDs, platform, source and file inventory; altered or unsafe archives fail. Packaging alone does not qualify a release.

For an explicit local paired run, use the candidate's exact source checkout and both preserved bundles:

```sh
pnpm release:evaluate --bundle CANDIDATE_BUNDLE --sha256 CANDIDATE_MANIFEST_DIGEST \
  --baseline-bundle APPROVED_BUNDLE --baseline-sha256 APPROVED_MANIFEST_DIGEST \
  --baseline-approval APPROVED_CANDIDATE_DIGEST --mode live --profile deepseek \
  --output NEW_RUN_DIRECTORY
```

The evaluator runs saved images without rebuilding and checks their identities. The complete reviewed private dataset must be present and digest-verified. Local live evaluation is explicit and uses the evaluation key.

Seal the resulting complete comparison and verify it:

```sh
pnpm release:seal --evaluation RUN_DIRECTORY --profile deepseek --source-sha FULL_COMMIT_SHA \
  --bundle CANDIDATE_BUNDLE --bundle-sha256 CANDIDATE_MANIFEST_DIGEST --output CANDIDATE_FILE
pnpm release:verify CANDIDATE_FILE --sha256 PINNED_CANDIDATE_DIGEST
```

The verifier regrades original evidence and checks coverage and identities. A saved passing summary is insufficient. Keep original failed attempts. `release:archive` and `release:archive:restore` preserve private evidence for transfer; archives do not restart evidence retention. Page/provider evidence remains subject to its original expiry, while source/image identities and approval history are retained separately. Preserve known charges and explicit unknown accounting independently of run cleanup.

## Release versions and notes

Use the package version and sequential rc tags for candidate assets. Notes identify source, model/provider settings, the case collection, no-regression result, retained failures, latency, reported/unknown costs and changelog. Stable publication must reuse the qualified images. Keep tags and assets referenced by the current or previous approval.

Historical reports retain their original rules. Replay them from their recorded source rather than keeping old policy branches in today's evaluator or reinterpreting old results under the current policy.

## Nightly monitoring

**Release Monitoring** runs at 02:17 UTC and supports manual dispatch. It restores the exact approved release and its complete frozen live collection. Each case runs once against the approved configuration; results are compared with the saved approval measurements. It does not run a second baseline arm, rebuild current main, repeat ordinary CI, or add cases introduced since approval.

Lost passes, operational failures and invalid artifacts fail the workflow. Latency and cost remain descriptive. Monitoring records last-started and last-completed runs and preserves evidence. It never changes approval, switches models, activates a release, rolls back, or stops the application.

The existing `v1.0.0` approval is preserved during migration. Its archived source, policy and original sentinel receipt continue to govern monitoring until a new approval is created by this flow. The new full-collection rule does not rewrite its historical measurements.

Run the same monitor locally with `pnpm release:monitor`. A controlled notification check uses `pnpm release:monitor --notification-test` without inference. GitHub schedules and email are best effort: verify actual delivery separately; a failed job does not prove an email arrived, and a schedule that never starts cannot send a workflow-failure notification.

## Migration status

The accepted design replaces historical pilot/confirmation, held-out exhaustion and aggregate-correctness gates. Existing approved images and historical evidence remain intact. Private dataset publication and the persistent release branch are configured. Before claiming the new release path operational, verify trusted release-PR execution, an actual complete comparison, merge-time approval checks and explicit activation independently. Documentation and local deterministic checks alone establish none of those external outcomes.
