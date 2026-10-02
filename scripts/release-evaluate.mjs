import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { verify, localDockerHost, localDocker, restoreVerified } from "./release-bundle.mjs";
import {
  parseQualificationOptions,
  profiles,
  validateReleaseArtifact,
} from "../evaluation/qualify.mjs";

const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
function checkSource(sha) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", env }).trim();
  ensure(
    git("rev-parse", "HEAD") === sha && !git("status", "--porcelain", "--untracked-files=all"),
    "Bundle qualification requires its exact clean source checkout",
  );
}

async function attest(path, stage) {
  ensure(["before", "after"].includes(stage), "Invalid artifact attestation stage");
  const state = await json(path);
  validateReleaseArtifact(state.artifact, state.artifact.sourceSha, [state.artifact.profileId]);
  checkSource(state.artifact.sourceSha);
  ensure(
    process.env.COMPOSE_PROJECT_NAME === state.project && process.cwd() === state.directory,
    "Artifact workspace identity mismatch",
  );
  const docker = await localDocker(state.dockerHost);
  const observed = [];
  const baselineObserved = [];
  const images = state.comparison
    ? [...state.artifact.images, ...state.comparison.artifact.images]
    : state.artifact.images;
  for (let index = 0; index < images.length; index++) {
    const image = images[index];
    const reference = index >= 2;
    const service = reference
      ? `${image.component}-baseline`
      : image.component === "browser"
        ? "browser"
        : state.service;

    const ids = (
      await docker([
        "ps",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `label=com.docker.compose.project=${state.project}`,
        "--filter",
        `label=com.docker.compose.service=${service}`,
      ])
    )
      .split(/\s+/u)
      .filter(Boolean);
    ensure(
      ids.length === 1 && /^[a-f\d]{64}$/.test(ids[0]),
      "Expected exactly one running artifact container per component",
    );
    const result = JSON.parse(await docker(["inspect", ids[0]]));
    const container = result[0];
    const labels = container?.Config?.Labels;
    ensure(
      result.length === 1 &&
        container.Id === ids[0] &&
        container.Image === image.id &&
        container.State?.Running === true &&
        labels?.["com.docker.compose.project"] === state.project &&
        labels?.["com.docker.compose.service"] === service &&
        labels?.["com.docker.compose.project.working_dir"] === state.directory,
      "Running container artifact identity mismatch",
    );
    (reference ? baselineObserved : observed).push({
      component: image.component,
      imageId: container.Image,
      containerId: container.Id,
    });
  }
  const output = process.env.XPATHED_EVALUATION_OUTPUT;
  ensure(output === state.output, "Artifact output identity mismatch");
  if (stage === "before")
    await save(join(output, "artifact-before.json"), {
      version: 1,
      artifact: state.artifact,
      observed,
      ...(state.comparison ? { comparison: state.comparison, baselineObserved } : {}),
    });
  else {
    const before = await json(join(output, "artifact-before.json"));
    ensure(
      isDeepStrictEqual(before.artifact, state.artifact) &&
        isDeepStrictEqual(before.observed, observed) &&
        isDeepStrictEqual(before.comparison, state.comparison) &&
        (!state.comparison || isDeepStrictEqual(before.baselineObserved, baselineObserved)),
      "Artifact containers changed during qualification",
    );
    await save(join(output, "artifact-receipt.json"), {
      version: 1,
      artifact: state.artifact,
      before: before.observed,
      after: observed,
      ...(state.comparison
        ? {
            comparison: state.comparison,
            baselineBefore: before.baselineObserved,
            baselineAfter: baselineObserved,
          }
        : {}),
    });
  }
  process.stdout.write(JSON.stringify(state.artifact));
}

async function main() {
  process.umask(0o077);
  const args = process.argv.slice(2);
  if (args[0] === "attest") {
    ensure(args.length === 3, "Use attest STATE_FILE before|after");
    await attest(args[1], args[2]);
    return;
  }
  const options = {};
  const qualificationArgs = [];
  for (let i = 0; i < args.length; i += 2) {
    ensure(args[i + 1] && !args[i + 1].startsWith("--"), "Missing release evaluation option");
    if (
      [
        "--bundle",
        "--sha256",
        "--baseline-bundle",
        "--baseline-sha256",
        "--baseline-approval",
      ].includes(args[i])
    ) {
      ensure(!options[args[i]], "Duplicate release evaluation option");
      options[args[i]] = args[i + 1];
    } else qualificationArgs.push(args[i], args[i + 1]);
  }
  ensure(
    options["--bundle"] && options["--sha256"],
    "Use --bundle DIRECTORY --sha256 EXPECTED_DIGEST with qualification options",
  );
  const qualification = parseQualificationOptions(qualificationArgs);
  ensure(
    !qualification.replay &&
      !qualification.caseId &&
      qualification.repetitions === 1 &&
      qualification.profileIds.length === 1,
    "Bundle qualification requires one profile, one attempt and the complete selected split",
  );
  ensure(
    !process.env.XPATHED_CODE_REVISION &&
      !process.env.XPATHED_TREE_HASH &&
      !process.env.XPATHED_WORKSPACE,
    "Source identity overrides are not accepted",
  );
  const bundle = await verify(options["--bundle"], options["--sha256"]);
  const { manifest } = bundle;
  checkSource(manifest.sourceSha);
  ensure(
    manifest.profileId === qualification.profileIds[0],
    "Qualification profile differs from bundle",
  );
  ensure(
    Boolean(options["--baseline-bundle"]) === Boolean(options["--baseline-sha256"]),
    "Baseline bundle and digest are required together",
  );
  let comparison, baselineBundle, baselineConfig;
  if (options["--baseline-bundle"]) {
    baselineBundle = await verify(options["--baseline-bundle"], options["--baseline-sha256"]);
    baselineConfig = await json(join(baselineBundle.directory, "configuration.json"));
    const baselineManifest = baselineBundle.manifest;
    ensure(
      isDeepStrictEqual(baselineManifest.platform, manifest.platform),
      "Baseline platform differs",
    );
    comparison = {
      approval: options["--baseline-approval"] ?? null,
      artifact: {
        version: 1,
        bundleManifestSha256: options["--baseline-sha256"],
        sourceSha: baselineManifest.sourceSha,
        profileId: baselineManifest.profileId,
        images: baselineManifest.images,
        platform: baselineManifest.platform,
      },
      profile: baselineConfig.profile,
    };
    validateReleaseArtifact(comparison.artifact, baselineManifest.sourceSha, [
      baselineManifest.profileId,
    ]);
  }
  const config = await json(join(bundle.directory, "configuration.json"));
  const profile = profiles.find((p) => p.id === manifest.profileId);
  ensure(isDeepStrictEqual(config.profile, profile), "Current profile differs from bundle profile");
  const service = new URL(profile.resolver).hostname;
  ensure(/^resolver(?:-[a-z0-9-]+)?$/.test(service), "Unsupported resolver service");
  const artifact = {
    version: 1,
    bundleManifestSha256: options["--sha256"],
    sourceSha: manifest.sourceSha,
    profileId: manifest.profileId,
    images: manifest.images,
    platform: manifest.platform,
  };
  validateReleaseArtifact(artifact, manifest.sourceSha, qualification.profileIds);
  const host = await localDockerHost();
  const docker = await localDocker(host);
  await restoreVerified(bundle, docker);
  if (baselineBundle) await restoreVerified(baselineBundle, docker);
  const parent = resolve(".artifacts/releases");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(parent, ".qualification-"));
  try {
    const project = `xpathed-evaluation-${randomUUID()}`;
    const output = resolve(qualification.output);
    const state = {
      artifact,
      ...(comparison ? { comparison } : {}),
      service,
      project,
      directory: process.cwd(),
      output,
      dockerHost: host,
    };
    const statePath = join(temporary, "state.json");
    await save(statePath, state);
    const overlay = join(temporary, "compose.yaml");
    const imageService = (name, image, environment) =>
      `  ${name}:\n${name === "browser-baseline" ? `    extends: {file: ${JSON.stringify(resolve("docker/compose.yaml"))}, service: browser}\n` : ""}    build: !reset null\n    image: ${JSON.stringify(image.id)}\n    platform: ${manifest.platform.os}/${manifest.platform.architecture}\n    pull_policy: never\n${environment ? `    environment: ${JSON.stringify(environment)}\n` : ""}`;
    await writeFile(
      overlay,
      "services:\n" +
        imageService("browser", manifest.images[0]) +
        imageService(service, manifest.images[1], config.resolverEnvironment) +
        (comparison
          ? imageService("browser-baseline", comparison.artifact.images[0]) +
            imageService("resolver-baseline", comparison.artifact.images[1], {
              ...baselineConfig.resolverEnvironment,
              BrowserUrl: "http://browser-baseline:8080",
              OpenRouter__BaseUrl: "http://evaluation-fixture:8091/api/v1/",
              OpenRouter__ApiKey: "qualification-proxy-only",
            })
          : ""),
      { flag: "wx", mode: 0o600 },
    );
    const env = {
      ...process.env,
      DOCKER_HOST: host,
      DOCKER_CONTEXT: "",
      XPATHED_ENV_FILE: process.env.XPATHED_ENV_FILE || "/dev/null",
      XPATHED_EVALUATION_PROJECT: project,
      XPATHED_RELEASE_STATE: statePath,
      XPATHED_RELEASE_OVERLAY: overlay,
      XPATHED_RELEASE_SERVICE: service,
      XPATHED_RELEASE_COMPARISON_JSON: comparison ? JSON.stringify(comparison) : "",
    };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    const forwarded = [...qualificationArgs];
    if (!forwarded.includes("--output")) forwarded.push("--output", output);
    const status = await new Promise((resolve, reject) => {
      const child = spawn("sh", ["scripts/evaluate.sh", "--qualification", ...forwarded], {
        env,
        stdio: "inherit",
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
    ensure(status === 0, "Exact-artifact qualification failed; runtime default unchanged");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
