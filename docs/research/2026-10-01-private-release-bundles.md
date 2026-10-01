# Private Docker release bundles

Research date: 2026-10-01. This note supports the local artifact slice of [#11](https://github.com/Mochib-Tech-Solutions/xpathed/issues/11). It records primary-source semantics and a recommended implementation boundary; it is not a qualification result or a Docker roundtrip report.

## Source and build identity

`git archive --format=tar COMMIT` archives the named committed tree. Without additions it excludes untracked local `.env` and ignored working files. It does not sanitize secrets already committed. Avoid `--add-file` and `--worktree-attributes`. Archive attributes can omit files (`export-ignore`) or substitute contents (`export-subst`); repository-local `info/attributes` also affects export. Consequently, retain both the full commit SHA and the SHA-256 of the actual archive supplied to Docker. Do not describe every archive byte as an unchanged Git blob without checking these attributes. [Git archive](https://git-scm.com/docs/git-archive).

Docker accepts a tar archive on stdin as a filesystem build context. The Dockerfile selected by `--file` is resolved within that archive. Save one source archive and feed that same file to both builds; this avoids accidentally using different working trees. `.dockerignore` is additional build-context filtering, not protection for a retained source archive. [Docker build contexts](https://docs.docker.com/build/concepts/context/).

Use the existing Browser and Resolver Dockerfiles' `runtime` targets, an explicit Linux platform, and `--iidfile` to capture each build result. `--load` explicitly loads a single-platform result into the local image store; `--tag` assigns a reference and is unnecessary here. Inspect the result after a successful build, recording its full Docker image ID and platform. Build metadata distinguishes the configuration digest from the image manifest digest, so these must not be conflated. [Docker build options and metadata](https://docs.docker.com/reference/cli/docker/buildx/build/).

The current Dockerfiles pin base-image digests and use locked NuGet restores, but Browser also installs `x11vnc` through the distribution package repository. Therefore a source SHA does not establish a reproducible image. Preserve the actual built image bytes. These are repository observations from [Browser Dockerfile](../../docker/browser/Dockerfile) and [Resolver Dockerfile](../../docker/resolver/Dockerfile).

The CLI's active Docker context can target a remote daemon, and environment variables or command flags can override it. A private local workflow should explicitly verify its selected daemon/builder is local before sending source. Merely invoking Docker from this checkout does not establish locality. [Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/).

After resolving and validating a Unix-socket endpoint, pin `--host` for all daemon operations, clear inherited `DOCKER_CONTEXT`/`DOCKER_HOST`, and explicitly select `--builder default` for builds. Docker resolves an explicit host through its default context, and Buildx reserves the default builder for the Docker driver attached to that context. A read-only check on the installed Colima context confirmed that the fixed-socket default builder addressed the same worker; no source was uploaded for that check. [Docker CLI context resolution](https://github.com/docker/cli/blob/master/cli/command/cli.go), [Buildx context resolution](https://github.com/docker/buildx/blob/master/store/storeutil/storeutil.go), [Buildx default builder](https://docs.docker.com/build/builders/).

## Save, load and platform limits

`docker image save` writes an image archive, including image layers. Saving a repository name can include multiple tags. Its platform filter requires API 1.48 or newer; without that filter, available variants can be included. [Docker image save](https://docs.docker.com/reference/cli/docker/image/save/).

Saving by a **full image ID** avoids repository tags in the examined implementations. The classic exporter resolves digest IDs with no named reference; the containerd exporter explicitly clears the reference and removes name/ref annotations for a resolved digest. This supports a tag-free bundle without temporary application tags. These are implementation observations, not a claim that every historical Docker version behaves identically. [Moby classic exporter](https://github.com/moby/moby/blob/master/daemon/internal/image/tarexport/save.go), [Moby containerd exporter](https://github.com/moby/moby/blob/master/daemon/containerd/image_exporter.go).

Loading restores images and any archived tags. It is an image-store operation, not a container start or application rollout. A complete archive can be loaded without fetching it from a registry; creation may still download base images and build dependencies. Verify IDs and platform after loading, and test that existing application tags and containers remain unchanged. [Docker image load](https://docs.docker.com/reference/cli/docker/image/load/).

Do not promise identical Docker IDs across image-store backends. OCI defines an image's configuration hash separately from its manifest, while current Moby containerd inspection reports the target descriptor digest as `Id`. A target may be an index. [OCI image configuration](https://github.com/opencontainers/image-spec/blob/main/config.md), [Moby containerd inspection](https://github.com/moby/moby/blob/master/daemon/containerd/image_inspect.go).

The containerd store supports local multi-platform images and attestation indices that the classic store does not. It is the default on fresh Engine 29 installations, but upgraded installations can retain the classic store. Restrict this slice to one recorded Linux architecture and validate the installed store's roundtrip. Reject unsupported identity/platform combinations instead of silently translating them. [Docker containerd image store](https://docs.docker.com/engine/storage/containerd/).

In particular, the examined containerd exporter selects a platform manifest when exactly one platform is requested. An index's original ID can consequently differ from the exported platform target. Avoid assuming `save --platform` preserves an index ID, even for a build whose runnable image has only one architecture. [Moby containerd exporter](https://github.com/moby/moby/blob/master/daemon/containerd/image_exporter.go).

## Recommended small format

Use a private directory with exactly four files: `manifest.json`, `source.tar`, `images.tar`, and `configuration.json`. This is a design recommendation, not a Docker-defined format.

- The manifest binds a format version, creation time, source commit, one Linux platform, two roles (Browser and Resolver), full inspected image IDs, and each payload's byte count and SHA-256. Keep the manifest digest outside the bundle as the caller's trust anchor.
- The source archive is the single input used for both builds. The image archive is produced by saving those two full IDs, with no application tag arguments.
- Configuration is an explicit allowlist of the selected profile's nonsecret settings. Do not serialize process environment, Docker credentials, `.env`, database/browser volumes, or raw qualification evidence.
- Creation uses exclusive output and writes the final manifest only after both builds, save, and hashing succeed. Verification checks the externally pinned manifest digest before following its inventory; reject unexpected files, unsafe paths and unsupported formats.
- Restoration verifies first, loads only that archive, then inspects the expected identities and platform. Loading changes the image store; it is not transactional. Do not start services, mutate defaults, create release pointers, prune images, or claim an operational rollback.

Hash the archives incrementally with Node's `createReadStream` and SHA-256, counting bytes as chunks arrive. The standard library supports streaming hashes; no archive-sized `readFile` buffer or hashing dependency is necessary. Await stream errors and process completion, and keep the bundle unchanged between verification and use. [Node.js crypto streaming hashes](https://nodejs.org/docs/latest-v24.x/api/crypto.html#class-hash).

The trust claim is deliberately limited: an independently retained digest detects changes after packaging; it is neither a signature nor proof that trusted builders produced the images. A successful same-platform save/load test establishes preservation for the exercised Docker backend, not universal portability. Test corruption, wrong platform, missing images, and tag preservation explicitly before documenting restore success.

Packaging remains **unqualified**. An allowlisted experiment profile is not an approved release, and copying images does not tie them to historical model trials. The existing [release evidence verifier](../releases.md) retains its source, qualification and evidence-expiry checks. Long-lived artifact metadata cannot renew the original raw evidence's retention deadline. Promotion, exact-image qualification, operational rollback, registries and paid monitoring remain separate work.
