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
import { verifyExposure } from "./release-state.mjs";

const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safe = (path) =>
  typeof path === "string" &&
  /^\.artifacts\/[a-zA-Z0-9_./-]+$/.test(path) &&
  !path.split("/").some((p) => ["", ".", ".."].includes(p));

export const fetchRelease = (repo, tag, candidateSha256, destination) =>
  fetch(repo, tag, candidateSha256, destination);

export async function fetchApprovedRelease(snapshot, destination) {
  const release = snapshot.state.current;
  ensure(
    release?.status === "qualified" && release.contractVersion === "4",
    "No compatible approved release exists",
  );
  ensure(
    snapshot.state.history.at(-1)?.to === release.candidateSha256 &&
      snapshot.state.history.some(
        (entry) => entry.operation === "promote" && entry.to === release.candidateSha256,
      ),
    "Approved release audit is missing",
  );
  ensure(
    release.monitoring?.version === 1,
    "Approved monitoring receipt is missing; fresh verification is required",
  );
  verifyExposure(snapshot, release);
  return fetch(snapshot.repo, release.tag, release.candidateSha256, destination, release);
}

async function fetch(repo, tag, candidateSha256, destination, approved = null) {
  ensure(
    /^[\w.-]+\/[\w.-]+$/.test(repo) &&
      /^(?:candidate-\d+-\d+|v\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?)$/.test(tag) &&
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
        ...(approved ? [] : ["release-evidence.json.gz"]),
      ].flatMap((p) => ["--pattern", p]),
    ],
    { stdio: "inherit" },
  );
  const archivePath = join(download, "release-evidence.json.gz");
  let archiveBytes, candidate;
  if (approved) {
    candidate = {
      sourceSha: approved.sourceSha,
      profile: approved.profile,
      bundleSha256: approved.bundleSha256,
      bundle: approved.monitoring.bundle,
      suite: approved.monitoring.suite,
    };
  } else {
    archiveBytes = await readFile(archivePath);
    const archive = JSON.parse(gunzipSync(archiveBytes, { maxOutputLength: 256 * 1024 * 1024 }));
    ensure(
      archive.version === 1 &&
        safe(archive.candidateFile) &&
        archive.candidateSha256 === candidateSha256,
      "Published evidence differs from pinned candidate",
    );
    const candidateBytes = Buffer.from(
      archive.files?.[archive.candidateFile]?.data ?? "",
      "base64",
    );
    ensure(hash(candidateBytes) === candidateSha256, "Candidate digest mismatch");
    candidate = JSON.parse(candidateBytes);
    ensure(
      candidate.version === 2 &&
        candidate.status === "artifact-bound-evidence-verified" &&
        candidate.artifact?.sourceSha === candidate.sourceSha &&
        ["8", "9"].includes(candidate.configurations?.[`${candidate.profile}:4`]?.promptVersion),
      "Candidate is not a compatible current-view artifact",
    );
  }
  ensure(
    /^[a-f\d]{40}$/.test(candidate.sourceSha ?? "") &&
      safe(candidate.bundle) &&
      candidate.suite === "evaluation/current-view-qualification-cases.json",
    "Invalid approved source, bundle or suite",
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
  const verified = await verifyBundle(bundle, candidate.bundleSha256);
  ensure(
    verified.manifest.sourceSha === candidate.sourceSha &&
      verified.manifest.profileId === candidate.profile,
    "Approved bundle identity mismatch",
  );
  if (!approved)
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
      new Set(suite.sentinels).size === suite.sentinels.length &&
      suite.sentinels.every((id) =>
        suite.cases.some(
          (c) =>
            c.id === id &&
            c.contractVersion === "4" &&
            ["development", "regression"].includes(c.split),
        ),
      ),
    "Frozen sentinel membership is missing",
  );
  if (approved) {
    ensure(
      hash(JSON.stringify(suite)) === approved.monitoring.suiteSha256,
      "Approved suite mismatch",
    );
    ensure(hash(JSON.stringify(policy)) === approved.policySha256, "Approved policy mismatch");
    ensure(
      hash(JSON.stringify(suite.sentinels)) === approved.sentinelSha256,
      "Approved sentinel membership mismatch",
    );
    ensure(
      Array.isArray(approved.sentinelBaseline) &&
        approved.sentinelBaseline.length === suite.sentinels.length &&
        new Set(approved.sentinelBaseline.map((t) => t.caseId)).size === suite.sentinels.length &&
        approved.sentinelBaseline.every(
          (t) =>
            suite.sentinels.includes(t.caseId) &&
            Number.isFinite(t.elapsedMs) &&
            t.elapsedMs >= 0 &&
            (["4", "5", "6"].includes(policy.version)
              ? typeof t.passed === "boolean" && !t.operational && !t.hardFailure
              : t.elapsedMs <= policy.deadlineMs),
        ),
      "Approved sentinel baseline is invalid",
    );
    return { source, candidate, release: approved };
  }
  const { measuredEntry } = ["4", "5", "6"].includes(policy.version)
    ? await import(pathToFileURL(join(source, "evaluation/release-comparison.mjs")))
    : {};
  const measured = [];
  for (const run of [candidate.pilot, candidate.confirmation]) {
    const manifest = JSON.parse(await readFile(join(source, run, "manifest.json"), "utf8"));
    for (const planned of manifest.plan.trials)
      if (suite.sentinels.includes(planned.caseId)) {
        const trial = JSON.parse(
          await readFile(join(source, run, "trials", `${planned.id}.json`), "utf8"),
        );
        const measurement = ["4", "5", "6"].includes(policy.version)
          ? measuredEntry(
              suite.cases.find((c) => c.id === trial.caseId),
              trial,
              manifest.profiles.find((p) => p.id === trial.profileId),
              policy,
            )
          : null;
        ensure(
          trial.mode === "live" &&
            (measurement
              ? !measurement.operational && !measurement.hardFailure
              : gradeTrial(
                  suite.cases.find((c) => c.id === trial.caseId),
                  trial,
                ).passed === true &&
                trial.result?.summary?.processingComplete === true &&
                Number.isFinite(trial.elapsedMs) &&
                trial.elapsedMs <= policy.deadlineMs),
          "A sentinel lacks a valid measured baseline",
        );
        measured.push(measurement ?? { caseId: trial.caseId, elapsedMs: trial.elapsedMs });
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
      ...(candidate.comparison ? { comparison: candidate.comparison } : {}),
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
      monitoring: {
        version: 1,
        bundle: candidate.bundle,
        suite: candidate.suite,
        suiteSha256: hash(JSON.stringify(suite)),
      },
    },
  };
}
