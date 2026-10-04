import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
      for (const name of ["DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_SSH_KEY", "DEPLOY_KNOWN_HOSTS"])
        if (!process.env[name]) throw new Error(`Missing ${name}`);
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
      execFileSync(
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
        { input: archive, stdio: ["pipe", "inherit", "inherit"] },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
