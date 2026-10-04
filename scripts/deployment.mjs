import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { lookup } from "node:dns/promises";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Docker COPY inputs and hosted orchestration. Evaluation, tests and docs are excluded.
export const inputs = [
  "src/Common",
  "src/Browser",
  "src/Resolver",
  "src/ClientApi",
  "src/Web",
  "docker/browser",
  "docker/resolver",
  "docker/client-api",
  "docker/web",
  "docker/hosted",
  "docker/compose.yaml",
  "scripts/deployment.mjs",
  "scripts/deployment-host.py",
  "scripts/deployment-network.py",
  "scripts/deployment-receiver.py",
  "global.json",
  "Directory.Build.props",
  "Directory.Build.targets",
  ".editorconfig",
  ".dockerignore",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
];

export function secretFile(value) {
  return `${value.replace(/\r\n?/g, "\n").trim()}\n`;
}

export function deploymentAddresses(environment) {
  let url;
  try {
    url = new URL(environment.DEPLOY_PUBLIC_URL);
  } catch {
    throw new Error("Invalid deployment public URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid deployment public URL");
  return [environment.DEPLOY_PUBLIC_URL, url.hostname, environment.DEPLOY_HOST].filter(Boolean);
}

export async function resolvedDeploymentAddresses(environment, resolve = lookup) {
  const addresses = deploymentAddresses(environment);
  try {
    const resolved = await resolve(environment.DEPLOY_HOST, { all: true });
    return [...addresses, ...resolved.map((entry) => entry.address)];
  } catch {
    throw new Error("Cannot resolve deployment connection address");
  }
}

export function redactDeploymentOutput(value, addresses) {
  for (const address of addresses) {
    const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    value = value.replace(new RegExp(escaped, "gi"), "[deployment address]");
  }
  return value;
}

export async function runDeployment(
  command,
  args,
  input,
  addresses,
  write = (line) => process.stdout.write(line),
) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  // Read complete lines so even addresses split across pipe chunks are removed.
  const readers = [child.stdout, child.stderr].map((stream) => createInterface({ input: stream }));
  for (const reader of readers)
    reader.on("line", (line) => write(`${redactDeploymentOutput(line, addresses)}\n`));
  child.stdin.on("error", () => {}); // Early SSH rejection can close stdin; exit status remains authoritative.
  const status = await new Promise((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", resolve);
    child.stdin.end(input);
  });
  if (status !== 0)
    throw new Error(
      `Deployment command failed (exit ${status ?? "unavailable"}); inspect the redacted output.`,
    );
}

export function fingerprint(revision, cwd = process.cwd()) {
  if (!/^[a-f\d]{40}$/.test(revision)) throw new Error("Invalid deployment revision");
  const tree = execFileSync("git", ["ls-tree", "-r", "-z", revision, "--", ...inputs], { cwd });
  if (!tree.length) throw new Error("Missing deployment inputs");
  return createHash("sha256").update(tree).digest("hex");
}

if (import.meta.main) {
  const revision = process.env.GITHUB_SHA;
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/git/ref/heads/main`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) throw new Error("Cannot verify current main revision");
  const current = (await response.json()).object.sha;
  if (current !== revision) {
    console.log("Skipped superseded main revision.");
  } else {
    const directory = mkdtempSync(join(tmpdir(), "xpathed-deployment-"));
    try {
      for (const name of [
        "DEPLOY_HOST",
        "DEPLOY_USER",
        "DEPLOY_SSH_KEY",
        "DEPLOY_KNOWN_HOSTS",
        "DEPLOY_PUBLIC_URL",
      ])
        if (!process.env[name]) throw new Error(`Missing ${name}`);
      const addresses = await resolvedDeploymentAddresses(process.env);
      if (process.env.GITHUB_ACTIONS === "true")
        for (const value of addresses)
          console.log(
            `::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
          );
      if (
        !/^[a-zA-Z0-9.-]+$/.test(process.env.DEPLOY_HOST) ||
        !/^[a-zA-Z0-9_-]+$/.test(process.env.DEPLOY_USER)
      )
        throw new Error("Invalid deployment connection settings");
      const key = join(directory, "key");
      const hosts = join(directory, "known_hosts");
      writeFileSync(key, secretFile(process.env.DEPLOY_SSH_KEY), { mode: 0o600 });
      writeFileSync(hosts, secretFile(process.env.DEPLOY_KNOWN_HOSTS), { mode: 0o600 });
      const archive = execFileSync("git", ["archive", "--format=tar", revision], {
        maxBuffer: 64 * 1024 * 1024,
      });
      await runDeployment(
        "ssh",
        [
          "-i",
          key,
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          `UserKnownHostsFile=${hosts}`,
          "-o",
          "ConnectTimeout=15",
          `${process.env.DEPLOY_USER}@${process.env.DEPLOY_HOST}`,
          `deploy ${revision} ${fingerprint(revision)}`,
        ],
        archive,
        addresses,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
