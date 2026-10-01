import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { createGunzip, gunzipSync } from "node:zlib";
import { verify as verifyBundle } from "./release-bundle.mjs";

const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safe = (path) =>
  typeof path === "string" &&
  /^\.artifacts\/[a-zA-Z0-9_./-]+$/.test(path) &&
  !path.split("/").some((p) => ["", ".", ".."].includes(p));

export async function fetchRelease(repo, tag, candidateSha256, destination) {
  ensure(
    /^[\w.-]+\/[\w.-]+$/.test(repo) &&
      /^candidate-\d+-\d+$/.test(tag) &&
      /^[a-f\d]{64}$/.test(candidateSha256),
    "Use an exact private candidate tag and independently pinned candidate digest",
  );
  const root = resolve(destination),
    download = join(root, "download"),
    source = join(root, "source");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(download, { mode: 0o700 });
  execFileSync(
    "gh",
    [
      "release",
      "download",
      tag,
      "--repo",
      repo,
      "--dir",
      download,
      ...[
        "manifest.json",
        "configuration.json",
        "source.tar",
        "images.tar.gz.part-*",
        "release-evidence.json.gz",
      ].flatMap((p) => ["--pattern", p]),
    ],
    { stdio: "inherit" },
  );
  const archivePath = join(download, "release-evidence.json.gz");
  const archiveBytes = await readFile(archivePath);
  const archive = JSON.parse(gunzipSync(archiveBytes, { maxOutputLength: 256 * 1024 * 1024 }));
  ensure(
    archive.version === 1 &&
      safe(archive.candidateFile) &&
      archive.candidateSha256 === candidateSha256,
    "Published evidence differs from pinned candidate",
  );
  const candidateBytes = Buffer.from(archive.files?.[archive.candidateFile]?.data ?? "", "base64");
  ensure(hash(candidateBytes) === candidateSha256, "Candidate digest mismatch");
  const candidate = JSON.parse(candidateBytes);
  ensure(
    candidate.version === 2 &&
      candidate.status === "artifact-bound-evidence-verified" &&
      /^[a-f\d]{40}$/.test(candidate.sourceSha ?? "") &&
      safe(candidate.bundle) &&
      candidate.artifact?.sourceSha === candidate.sourceSha &&
      candidate.configurations?.[`${candidate.profile}:4`]?.promptVersion === "8",
    "Candidate is not a compatible current-view artifact",
  );
  try {
    execFileSync("git", ["cat-file", "-e", `${candidate.sourceSha}^{commit}`], { stdio: "pipe" });
  } catch {
    const env = { ...process.env };
    if (env.GH_TOKEN)
      Object.assign(env, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString("base64")}`,
      });
    execFileSync("git", ["fetch", `https://github.com/${repo}.git`, candidate.sourceSha], {
      env,
      stdio: "inherit",
    });
  }
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", process.cwd(), source], {
    stdio: "inherit",
  });
  execFileSync("git", ["-C", source, "checkout", "--quiet", "--detach", candidate.sourceSha], {
    stdio: "inherit",
  });
  const bundle = join(source, candidate.bundle);
  await mkdir(bundle, { recursive: true, mode: 0o700 });
  for (const name of ["manifest.json", "configuration.json", "source.tar"])
    await copyFile(join(download, name), join(bundle, name));
  const chunks = (await readdir(download))
    .filter((name) => /^images\.tar\.gz\.part-\d{4}$/.test(name))
    .sort();
  ensure(
    chunks.length > 0 && chunks.every((name, i) => name.endsWith(String(i).padStart(4, "0"))),
    "Image transport chunks are missing",
  );
  async function* compressed() {
    for (const name of chunks) yield* createReadStream(join(download, name));
  }
  await pipeline(
    Readable.from(compressed()),
    createGunzip(),
    createWriteStream(join(bundle, "images.tar"), { flags: "wx", mode: 0o600 }),
  );
  await verifyBundle(bundle, candidate.bundleSha256);
  execFileSync(
    process.execPath,
    ["scripts/release-archive.mjs", "restore", archivePath, "--sha256", hash(archiveBytes)],
    { cwd: source, stdio: "inherit" },
  );
  const suite = JSON.parse(await readFile(join(source, candidate.suite), "utf8"));
  const { gradeTrial } = await import(pathToFileURL(join(source, "evaluation/grader.mjs")));
  const policy = JSON.parse(
    await readFile(join(source, "evaluation/current-view-qualification-policy.json"), "utf8"),
  );
  ensure(
    Array.isArray(suite.sentinels) &&
      suite.sentinels.length > 0 &&
      new Set(suite.sentinels).size === suite.sentinels.length,
    "Frozen sentinel membership is missing",
  );
  const measured = [];
  for (const run of [candidate.pilot, candidate.confirmation]) {
    const manifest = JSON.parse(await readFile(join(source, run, "manifest.json"), "utf8"));
    for (const planned of manifest.plan.trials)
      if (suite.sentinels.includes(planned.caseId)) {
        const trial = JSON.parse(
          await readFile(join(source, run, "trials", `${planned.id}.json`), "utf8"),
        );
        ensure(
          trial.mode === "live" &&
            gradeTrial(
              suite.cases.find((c) => c.id === trial.caseId),
              trial,
            ).passed === true &&
            trial.result?.summary?.processingComplete === true &&
            Number.isFinite(trial.elapsedMs) &&
            trial.elapsedMs <= policy.deadlineMs,
          "A sentinel lacks a correct complete measured baseline",
        );
        measured.push({ caseId: trial.caseId, elapsedMs: trial.elapsedMs });
      }
  }
  ensure(
    measured.length === suite.sentinels.length &&
      new Set(measured.map((t) => t.caseId)).size === suite.sentinels.length,
    "Sentinel baseline inventory differs",
  );
  return {
    source,
    candidate,
    release: {
      status: "qualified",
      tag,
      candidateSha256,
      bundleSha256: candidate.bundleSha256,
      evidenceArchiveSha256: hash(archiveBytes),
      sourceSha: candidate.sourceSha,
      profile: candidate.profile,
      contractVersion: "4",
      policySha256: candidate.policySha256,
      sentinelSha256: hash(JSON.stringify(suite.sentinels)),
      sentinelBaseline: measured,
      exposure: candidate.exposure,
    },
  };
}
