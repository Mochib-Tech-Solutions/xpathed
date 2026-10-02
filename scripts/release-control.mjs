import { assertLatestBaseline } from "./release-baseline.mjs";
import policy from "../evaluation/current-view-qualification-policy.json" with { type: "json" };
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fetchRelease } from "./release-fetch.mjs";
import { readState, saveState, transition, actor, verifyExposure } from "./release-state.mjs";
import { localDockerHost, localDocker, verify, restoreVerified } from "./release-bundle.mjs";

const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
export async function checkRuntime(docker, web, contract, waitMs = 0) {
  const deadline = Date.now() + waitMs;
  do {
    try {
      for (const [url, expected] of [
        ["http://web:8080/release-contract.json", { version: 1, resolutionContract: contract }],
        [
          "http://web:8080/health",
          { service: "client-api", database: "connected", resolutionContract: contract },
        ],
        ...(waitMs
          ? [
              ["http://web:8080/view/health", { service: "browser" }],
              ["http://resolver:8080/health", { service: "resolver" }],
            ]
          : []),
      ]) {
        const value = JSON.parse(await docker(["exec", web, "wget", "-T", "3", "-qO-", url]));
        ensure(
          Object.entries(expected).every(([key, item]) => value[key] === item),
          "Installed client contract or service readiness differs from approval",
        );
      }
      return;
    } catch {
      if (Date.now() >= deadline)
        throw new Error("Approved runtime HTTP readiness or client compatibility check failed");
      await delay(1000);
    }
  } while (true);
}
async function main() {
  process.umask(0o077);
  const [operation, ...args] = process.argv.slice(2),
    options = {};
  ensure(
    ["promote", "rollback", "activate"].includes(operation) && args.length % 2 === 0,
    "Use promote|rollback|activate with named options",
  );
  for (let i = 0; i < args.length; i += 2) {
    ensure(
      ["--tag", "--sha256", "--expected-current", "--reason"].includes(args[i]) &&
        !Object.hasOwn(options, args[i]) &&
        args[i + 1],
      "Invalid release option",
    );
    options[args[i]] = args[i + 1];
  }
  const snapshot = readState();
  ensure(
    options["--expected-current"] === (snapshot.state.current?.candidateSha256 ?? "none"),
    "Approved release changed; refresh before proceeding",
  );
  const target =
    operation === "promote"
      ? { tag: options["--tag"], candidateSha256: options["--sha256"] }
      : operation === "rollback"
        ? snapshot.state.previous
        : snapshot.state.current;
  ensure(target, "No retained qualified release is available");
  const parent = resolve(".artifacts/releases");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parent, `${operation}-`));
  const staged = await fetchRelease(snapshot.repo, target.tag, target.candidateSha256, directory);
  verifyExposure(snapshot, staged.release);
  if (operation === "promote")
    assertLatestBaseline(staged.release.comparison, snapshot.state.current, policy);
  if (operation !== "activate") {
    const next = transition(snapshot.state, operation, staged.release, {
      expectedCurrent: options["--expected-current"],
      actor: actor(),
      reason: options["--reason"],
    });
    saveState(
      snapshot,
      next,
      `chore(release): ${operation} ${target.candidateSha256.slice(0, 12)}`,
    );
    console.log(
      `Approved selection updated. Run release:activate with --expected-current ${target.candidateSha256} to deploy this exact selection locally.`,
    );
    return;
  }
  const host = await localDockerHost(),
    docker = await localDocker(host);
  const env = { ...process.env, DOCKER_HOST: host, DOCKER_CONTEXT: "" };
  const config = JSON.parse(
    execFileSync("sh", ["docker/compose.sh", "config", "--format", "json"], {
      env,
      encoding: "utf8",
    }),
  );
  const ids = (
    await docker([
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${config.name}`,
    ])
  )
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length)
    for (const container of JSON.parse(await docker(["inspect", ...ids]))) {
      const labels = container.Config?.Labels;
      ensure(
        labels?.["com.docker.compose.project.working_dir"] === process.cwd(),
        "Compose project belongs to another checkout",
      );
      ensure(
        !labels?.["com.docker.compose.project.config_files"]?.includes("compose.dev.yaml"),
        "Stop this checkout's development runner before activating runtime images",
      );
    }
  const web = (
    await docker([
      "ps",
      "--quiet",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${config.name}`,
      "--filter",
      "label=com.docker.compose.service=web",
    ])
  ).trim();
  ensure(
    /^[a-f\d]{64}$/.test(web),
    "Start a compatible runtime Web and ClientApi before activation",
  );
  await checkRuntime(docker, web, staged.release.contractVersion);
  const bundle = await verify(
    join(staged.source, staged.candidate.bundle),
    staged.candidate.bundleSha256,
  );
  await restoreVerified(bundle, docker);
  const releaseConfig = JSON.parse(await readFile(join(bundle.directory, "configuration.json")));
  const overlay = join(parent, "approved-compose.yaml");
  const services = bundle.manifest.images
    .map(
      (image) =>
        `  ${image.component}:\n    build: !reset null\n    image: ${JSON.stringify(image.id)}\n    platform: ${image.os}/${image.architecture}\n    pull_policy: never\n${image.component === "resolver" ? `    environment: ${JSON.stringify(releaseConfig.resolverEnvironment)}\n` : ""}`,
    )
    .join("");
  await writeFile(overlay, "services:\n" + services, { mode: 0o600 });
  const receipt = {
    version: 1,
    release: staged.release,
    project: config.name,
    operation: "activation",
    status: "pending",
    startedAt: new Date().toISOString(),
  };
  const receiptPath = join(parent, "deployment.json");
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  try {
    execFileSync(
      "sh",
      [
        "docker/compose.sh",
        "-f",
        overlay,
        "up",
        "--no-build",
        "--pull",
        "never",
        "--wait",
        "--no-deps",
        "--force-recreate",
        "browser",
        "resolver",
      ],
      { env, stdio: "inherit" },
    );
    await docker(["exec", web, "nginx", "-s", "reload"]);
    await checkRuntime(docker, web, staged.release.contractVersion, 60000);
    const observed = [];
    for (const image of bundle.manifest.images) {
      const id = (
        await docker([
          "ps",
          "--quiet",
          "--no-trunc",
          "--filter",
          `label=com.docker.compose.project=${config.name}`,
          "--filter",
          `label=com.docker.compose.service=${image.component}`,
        ])
      ).trim();
      ensure(/^[a-f\d]{64}$/.test(id), "Expected one running deployed component");
      const [container] = JSON.parse(await docker(["inspect", id]));
      ensure(
        container.Image === image.id && container.State?.Running === true,
        "Deployed image differs from approval",
      );
      observed.push({ component: image.component, imageId: image.id, containerId: id });
    }
    ensure(
      readState(snapshot.repo).state.current?.candidateSha256 === target.candidateSha256,
      "Approved selection changed during activation",
    );
    Object.assign(receipt, { status: "active", observed, completedAt: new Date().toISOString() });
  } catch (error) {
    Object.assign(receipt, {
      status: "failed",
      error: error.message,
      completedAt: new Date().toISOString(),
    });
    throw error;
  } finally {
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  }
  console.log(
    "Exact approved Browser and Resolver images are active. Browser sessions were restarted; application credentials and database volumes were retained.",
  );
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
