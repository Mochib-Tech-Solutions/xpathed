import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { verify, localDocker, restoreVerified } from "./bundle.mjs";

export const deploymentFiles = [
  "compose.release.yaml",
  "browser-seccomp.json",
  "release.env.example",
];
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
export function repositoryName() {
  return (
    process.env.GITHUB_REPOSITORY ||
    JSON.parse(gh("repo", "view", "--json", "nameWithOwner")).nameWithOwner
  );
}
export function releaseCommit(repository) {
  return JSON.parse(gh("api", `repos/${repository}/git/ref/heads/release`)).object.sha;
}
export function publishedRelease(repository, commit) {
  if (!/^[a-f\d]{40}$/.test(commit ?? "")) throw new Error("An exact release commit is required");
  const releases = JSON.parse(
    gh("api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`),
  ).flat();
  const matches = releases.filter(
    (release) => !release.draft && !release.prerelease && release.target_commitish === commit,
  );
  if (matches.length !== 1)
    throw new Error("Expected one published release for the exact release commit");
  return matches[0];
}
export function validateReceipt(receipt, commit) {
  if (
    receipt.commit !== commit ||
    !/^[a-f\d]{40}$/.test(receipt.testedCommit ?? "") ||
    !/^[a-f\d]{40}$/.test(receipt.tree ?? "") ||
    !/^[a-f\d]{64}$/.test(receipt.bundleSha256 ?? "") ||
    !deploymentFiles.every((name) => /^[a-f\d]{64}$/.test(receipt.deploymentFiles?.[name] ?? ""))
  )
    throw new Error("Published receipt does not identify the requested release");
}
export async function unpackImages(download, bundle) {
  const parts = (await readdir(download))
    .filter((name) => /^browser-resolver-images\.tar\.gz\.part-\d{4}$/.test(name))
    .sort();
  if (!parts.length || parts.some((name, i) => !name.endsWith(String(i).padStart(4, "0"))))
    throw new Error("Release image parts are missing");
  async function* chunks() {
    for (const part of parts) yield* createReadStream(join(download, part));
  }
  await pipeline(
    Readable.from(chunks()),
    createGunzip(),
    createWriteStream(join(bundle, "images.tar"), { flags: "wx" }),
  );
}
export async function downloadRelease(repository, commit, destination) {
  const release = publishedRelease(repository, commit);
  const directory = resolve(destination);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  gh(
    "release",
    "download",
    release.tag_name,
    "--repo",
    repository,
    "--dir",
    directory,
    ...[
      "release.json",
      "monitoring-baseline.json",
      "manifest.json",
      "source.tar",
      "browser-resolver-images.tar.gz.part-*",
      ...deploymentFiles,
    ].flatMap((name) => ["--pattern", name]),
  );
  const receipt = JSON.parse(await readFile(join(directory, "release.json")));
  validateReceipt(receipt, commit);
  for (const name of deploymentFiles)
    if (hash(await readFile(join(directory, name))) !== receipt.deploymentFiles[name])
      throw new Error(`Deployment file integrity mismatch: ${name}`);
  if (
    hash(await readFile(join(directory, "monitoring-baseline.json"))) !== receipt.monitoringSha256
  )
    throw new Error("Monitoring measurements differ from the published receipt");
  const bundle = join(directory, "bundle");
  await mkdir(bundle);
  await unpackImages(directory, bundle);
  for (const name of ["manifest.json", "source.tar"])
    await rename(join(directory, name), join(bundle, name));
  const verified = await verify(bundle, receipt.bundleSha256);
  if (verified.manifest.sourceSha !== receipt.testedCommit)
    throw new Error("Published images have a different tested commit");
  await writeFile(
    join(directory, "images.env"),
    verified.manifest.images
      .map((image) => `XPATHED_${image.component.toUpperCase()}_IMAGE=${image.id}`)
      .join("\n") + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return { ...verified, receipt, root: directory };
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--output")
      throw new Error("Use release:download --output NEW_DIRECTORY");
    const repository = repositoryName();
    const downloaded = await downloadRelease(repository, releaseCommit(repository), args[1]);
    await restoreVerified(downloaded, await localDocker());
    console.log(
      `Verified Browser and Resolver images loaded for ${downloaded.receipt.commit}.\nDeployment files: ${downloaded.root}\nSupply .env, then run docker compose --env-file .env --env-file images.env -f compose.release.yaml up -d --no-build --pull never`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
