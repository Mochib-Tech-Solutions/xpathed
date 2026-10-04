# Release workflow

**Release publication is deferred.** Use [source setup](../README.md#clone-and-run-locally) for the runnable application. This retained runbook describes tooling and requirements if publication resumes; it does not identify an available application release or establish that monitoring is operational. Application release assets are currently unavailable.

**Passing checks → merge into `release` → publish that commit → use it as the next baseline.** Git is the source of release identity. [ADR-0026](adr/0026-use-the-release-branch-as-the-baseline.md) records the decision.

## Required checks before merge

Open a trusted same-repository `main` → `release` PR. Ordinary CI must pass for the exact proposed source. Release Qualification then builds the candidate and restores the current release’s published images, records their exact image identities, and runs one complete paired comparison with live provider inference. Both arms receive the same reviewed Live-browser Resolver and Saved-page selection cases and inference settings; original failures, accuracy, gains, lost passes, timing and reported/unknown costs are retained.

Every baseline pass must remain a pass. Missing required results, provider failures, privacy violations and mismatched evidence fail the check. Timing and unavailable accounting remain descriptive. Changing the PR source or release baseline requires a fresh comparison. Configure required checks in GitHub before allowing merges; repository workflows do not themselves provide branch protection.

Evidence sealing checks configuration consistency separately for Live-browser Resolver and Saved-page selection cases in each arm. Their scope identities and serialized schema metadata can differ; configuration drift within either category fails the check.

CI needs `OPENROUTER_EVAL_API_KEY` as a secret. Optional `OPENROUTER_MODEL` and `OPENROUTER_PROVIDER` repository variables configure inference; otherwise the documented development defaults apply. Reviewed datasets are fetched by digest. Keep ordinary CI provider-free and preserve the complete comparison denominator.

## Publish the merged commit

Merging the passing PR establishes the release and baseline immediately. Release Publication verifies the successful run, PR head, baseline parent, final source-tree equality and saved artifact digests. It publishes the tested Browser/Resolver image bytes under a Git release tag (`v1.0.0` for the fresh initial release, then `release-FULL_COMMIT_SHA`), with source, evaluation evidence and monitoring measurements. It does not rebuild the candidate or request another approval.

Assets upload to a draft and their SHA-256 digests are verified before publication. A failed upload leaves the draft resumable; repair and rerun publication for that commit. A published tag cannot be reused for different source. Published assets identify both the tested PR merge commit and final merged commit, which may differ while their trees match. Historical artifacts remain historical evidence and are never selected through an approval registry.

## Deployment configuration

Supply these through Docker/environment configuration:

- `OPENROUTER_API_KEY`: application secret.
- `OPENROUTER_MODEL` and `OPENROUTER_PROVIDER`: inference route.
- `OPENROUTER_BASE_URL` and `OPENROUTER_TIMEOUT_SECONDS`: endpoint and request timeout.

Release images contain the code and prompt. They do not contain secrets or install saved evaluation settings. Recorded nonsecret evaluation settings explain the measurements; deploying a different route does not inherit those measurements.

## Run the published Browser and Resolver

Prerequisites: Docker with Compose and authenticated `gh` access to the repository. Hosted images target Linux ARM64; use a matching Docker daemon. For another architecture, build the source locally.

No clone or Node installation is needed:

```sh
gh release download PUBLISHED_TAG --repo Mochib-Tech-Solutions/xpathed --dir xpathed-release
cd xpathed-release
cat browser-resolver-images.tar.gz.part-* | gzip -dc > images.tar
shasum -a 256 -c SHA256SUMS
docker image load --input images.tar
cp release.env.example .env
```

Proceed only when each command succeeds. Linux users can use `sha256sum --check SHA256SUMS`. Use the desired tag from GitHub Releases and a fresh directory; checksums cover the reconstructed archive and all downloaded payload files. The published `images.env` names the exact Browser/Resolver IDs.

An existing source clone with Node 24.16.0 and pnpm 12.8.1 can instead run `pnpm release:download --output .artifacts/deployment`, then enter that directory and copy `release.env.example` to `.env`. This command resolves the current `release` commit, verifies metadata, platform and image identity, and loads the images automatically. Its bundle files live under `bundle/`; the standalone download keeps them in the deployment directory.

Edit `.env` with your key, model and provider. The downloader does not create or overwrite your runtime settings. Then:

```sh
docker compose --env-file .env --env-file images.env -f compose.release.yaml up -d --no-build --pull never
curl --fail http://localhost:8082/health
curl --fail http://localhost:8083/health
docker compose --env-file .env --env-file images.env -f compose.release.yaml logs --tail 100
```

| File                                             | Purpose                                                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release.json`                                   | Final release commit, tested source, evidence and deployment-file digests                                                                            |
| `bundle/manifest.json`                           | Browser and Resolver component names, image IDs, platform, source and checksums                                                                      |
| `browser-resolver-images.tar.gz.part-0000`, etc. | Ordered compressed image archive parts, reassembled and verified by the downloader                                                                   |
| `bundle/images.tar`                              | Both exact tested images, loaded into Docker                                                                                                         |
| `bundle/source.tar`                              | Exact tested source, excluding ignored environment files                                                                                             |
| `compose.release.yaml`                           | Browser and Resolver services; no build definitions                                                                                                  |
| `browser-seccomp.json`                           | Browser sandbox policy from the tested source                                                                                                        |
| `release.env.example`                            | Template for the operator's `.env`                                                                                                                   |
| `SHA256SUMS`                                     | Checksums for all standalone payload files and reconstructed `images.tar`                                                                            |
| `images.env`                                     | Exact Browser and Resolver image IDs; contains no provider settings                                                                                  |
| `monitoring-baseline.json`                       | Original measurements for nightly comparison                                                                                                         |
| `candidate.json`, `release-evidence.json.gz`     | Published evaluation provenance and original evidence, included in the standalone download; fetched separately when using the clone-based downloader |

Docker image names are `xpathed/browser:TESTED_COMMIT` and `xpathed/resolver:TESTED_COMMIT`; Compose pins the immutable image IDs in `images.env`. Browser uses 1 GiB shared memory, the recorded seccomp policy and its nonroot image user. Resolver addresses `http://browser:8080` inside the network. Host ports bind to loopback; `.env` can change `BROWSER_PORT`, `RESOLVER_PORT`, `VIEWER_ORIGINS` and `BROWSER_MAX_SESSIONS`. Keep each deployment in its own directory and use `-p PROJECT_NAME` plus distinct ports for parallel deployments.

Stop with the same Compose flags and `down`. Publication does not connect to a deployment's Docker daemon. To update, download into a new directory, supply its environment file and deliberately replace the running deployment. Revert through Git and follow the same checks to roll back. `pnpm dev` continues to build the current local checkout and includes the Web/ClientApi test client.

### Use the APIs

Create a session, copy `sessionId` and `pageId` from its response, then navigate that page:

```sh
curl --fail -X POST http://localhost:8082/sessions
curl --fail -X POST http://localhost:8082/pages/PAGE_ID/navigate \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'
```

Copy `documentId` from the navigation response and resolve an instruction. This request makes a paid model call:

```sh
curl --fail -X POST http://localhost:8083/pages/PAGE_ID/resolve \
  -H 'Content-Type: application/json' \
  -d '{"documentId":"DOCUMENT_ID","instruction":"Click the Learn more link."}'
curl --fail -X DELETE http://localhost:8082/sessions/SESSION_ID
```

Replace the uppercase placeholders with the returned IDs. Each restart invalidates prior sessions. Browser creates the managed session and page; Resolver uses those same identities. The API contract and runnable request examples are in [runtime](runtime.md#browser-integration) and [resolution](resolution.md). Health endpoints confirm service availability; resolution with live provider inference additionally requires a valid OpenRouter route and key. Both APIs are loopback-only in this setup.

## Local image and evidence checks

Package a clean committed source and verify the resulting image bundle:

```sh
pnpm release:bundle --source-sha FULL_COMMIT_SHA --output NEW_BUNDLE_DIRECTORY
pnpm release:bundle:verify BUNDLE_DIRECTORY --sha256 MANIFEST_DIGEST
pnpm release:bundle:restore BUNDLE_DIRECTORY --sha256 MANIFEST_DIGEST
```

Bundles include source, images and integrity metadata. Restoring loads images without starting services or modifying environment settings. For subsequent release comparisons, download the existing release bundle and reuse its exact image bytes. The working checkout must stay clean while packaging the candidate.

Run a complete comparison with both bundles:

```sh
pnpm release:evaluate --bundle CANDIDATE_BUNDLE --sha256 CANDIDATE_DIGEST \
  --baseline-bundle BASELINE_BUNDLE --baseline-sha256 BASELINE_DIGEST \
  --baseline-commit RELEASE_COMMIT --mode live --output NEW_RUN_DIRECTORY
```

Use the candidate's exact source checkout. The launcher verifies and attests both bundles and starts the Resolver worker for Saved-page selection. Replay and evidence sealing validate results; they do not choose a release. Keep original attempts and charges, enforce original evidence expiry, and never infer success from a saved summary alone.

## Nightly monitoring

Monitoring runs at 02:17 UTC or through manual dispatch. It resolves `release`, finds that commit's published artifacts and measurements, and runs the matching source's complete frozen collection with the saved images. It compares results with the measurements recorded during release CI. Missing assets or changed inference settings fail explicitly; monitoring never substitutes another release or deploys anything.

`pnpm release:monitor` performs the same check locally. `pnpm release:monitor --notification-test` fails deliberately without inference. Original results and failures are retained as workflow artifacts. A schedule or failed job is not evidence that email was delivered.

The existing tooling retains a historical one-time initial-release transition tied to commit `a9a0d7caf0b7abc46902f9c7831aa3c1339298a6`. Removing published assets does not reset that transition. Before resuming publication, verify the release branch, baseline assets and acceptance policy explicitly; missing required assets fail rather than falling back to another implementation. Monitoring requires published images and measurements. Hosted publication and live execution must be verified separately from local deterministic tests.
