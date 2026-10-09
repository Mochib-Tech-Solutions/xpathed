import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { profiles, selectQualificationCases, readRun } from "../../evaluation/compare.mjs";
import { validateCases } from "../../evaluation/run.mjs";
import { loadCases } from "../../evaluation/cases/load.mjs";
import { measuredEntry } from "../../evaluation/comparison.mjs";
import { prepareBaseline, retiredReleaseCommit } from "./baseline.mjs";
const gh = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));
const node = (script, args) =>
  execFileSync(process.execPath, [script, ...args], { stdio: "inherit" });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function qualificationCoverage(suite, sourceExclusions = []) {
  const { cases, exclusions, sourceCases } = selectQualificationCases(
    validateCases(suite),
    {},
    sourceExclusions,
  );
  const blockers = cases.some(
    (spec) =>
      spec.review?.status !== "reviewed" ||
      !spec.review.reviewer?.trim() ||
      !Number.isFinite(Date.parse(spec.review.reviewedAt)),
  )
    ? ["Every live case requires independently reviewed labels"]
    : [];
  return { ready: !blockers.length, cases: cases.length, exclusions, sourceCases, blockers };
}
export function trustedReleasePR(event, repository) {
  const pr = event.pull_request;
  return (
    event.repository?.private === true &&
    pr?.base?.ref === "release" &&
    pr.head?.ref === "main" &&
    pr.head.repo?.full_name === repository &&
    pr.base.repo?.full_name === repository
  );
}
async function readCIGate(repository, run) {
  const directory = await mkdtemp(join(tmpdir(), "xpathed-ci-gate-"));
  try {
    execFileSync("gh", [
      "run",
      "download",
      String(run.id),
      "--repo",
      repository,
      "--name",
      `ci-gate-${run.run_attempt}`,
      "--dir",
      directory,
    ]);
    return JSON.parse(await readFile(join(directory, "gate.json"), "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function requireCI(repository, identity, waitMs = 0, api = gh, readGate = readCIGate) {
  const deadline = Date.now() + waitMs;
  do {
    const runs = api(
      `repos/${repository}/actions/workflows/check.yml/runs?event=pull_request&head_sha=${identity.headSha}&per_page=100`,
    ).workflow_runs;
    const run = runs
      .filter((run) => run.pull_requests.some((pr) => pr.number === identity.pr))
      .sort((a, b) => b.id - a.id)[0];
    if (run?.conclusion === "success") {
      const gate = await readGate(repository, run);
      if (
        gate.passed !== true ||
        gate.sha !== identity.sourceSha ||
        gate.runId !== String(run.id) ||
        gate.runAttempt !== String(run.run_attempt)
      )
        throw new Error("Ordinary CI receipt differs from the exact tested source or run");
      return;
    }
    if (run?.status === "completed" || Date.now() >= deadline)
      throw new Error(
        "Ordinary CI must pass for the exact tested source before release evaluation",
      );
    await delay(10000);
  } while (true);
}
export function caseChanges(previous, current) {
  const fields = [
    "track",
    "instruction",
    "fixture",
    "viewport",
    "expected",
    "mutation",
    "provider",
    "input",
  ];
  const fingerprint = (spec) =>
    hash(
      JSON.stringify(
        Object.fromEntries(
          fields.filter((field) => spec[field] !== undefined).map((field) => [field, spec[field]]),
        ),
      ),
    );
  const before = new Map(previous.map((spec) => [spec.id, fingerprint(spec)]));
  const after = new Map(current.map((spec) => [spec.id, fingerprint(spec)]));
  return {
    added: [...after.keys()].filter((id) => !before.has(id)),
    removed: [...before.keys()].filter((id) => !after.has(id)),
    changed: [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id)),
  };
}
async function main() {
  const env = process.env;
  const profileId = profiles[0].id;
  if (process.argv.length !== 2)
    throw new Error("Release CI uses the supplied environment, without a profile selector");
  if (!env.OPENROUTER_EVAL_API_KEY?.trim()) throw new Error("Missing evaluation key");
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  if (
    env.GITHUB_EVENT_NAME !== "pull_request" ||
    !trustedReleasePR(event, env.GITHUB_REPOSITORY) ||
    event.pull_request.merged ||
    !profiles.some((profile) => profile.id === profileId)
  )
    throw new Error("Live release evaluation requires a trusted main to release pull request");
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  if (
    git("rev-parse", "HEAD") !== env.GITHUB_SHA ||
    git("status", "--porcelain", "--untracked-files=all")
  )
    throw new Error("Evaluation requires the exact clean PR revision");
  await requireCI(
    env.GITHUB_REPOSITORY,
    {
      sourceSha: env.GITHUB_SHA,
      headSha: event.pull_request.head.sha,
      pr: event.number,
    },
    30 * 60000,
  );
  const root = ".artifacts/release-ci";
  await mkdir(root, { recursive: true, mode: 0o700 });
  const suite = loadCases();
  const coverage = qualificationCoverage(suite, []);
  if (!coverage.ready) throw new Error(coverage.blockers.join("; "));
  const baselineCommit = gh(`repos/${env.GITHUB_REPOSITORY}/git/ref/heads/release`).object.sha;
  if (baselineCommit !== event.pull_request.base.sha)
    throw new Error("Release branch moved; update the PR before evaluation");
  const preflight = {
    sourceSha: env.GITHUB_SHA,
    sourceTree: git("rev-parse", "HEAD^{tree}"),
    pr: event.number,
    headSha: event.pull_request.head.sha,
    mode: "live",
    profileId,
    baselineCommit,
    initialBaseline: baselineCommit === retiredReleaseCommit,
    coverage,
  };
  await writeFile(`${root}/preflight.json`, JSON.stringify(preflight, null, 2) + "\n");
  const bundle = `${root}/bundle`;
  node("scripts/release/bundle.mjs", [
    "create",
    "--source-sha",
    env.GITHUB_SHA,
    "--output",
    bundle,
  ]);
  const digest = hash(await readFile(`${bundle}/manifest.json`));
  await writeFile(`${root}/bundle-sha256.txt`, digest + "\n");
  const baseline = await prepareBaseline(env.GITHUB_REPOSITORY, baselineCommit, `${root}/baseline`);
  node("scripts/release/evaluate.mjs", [
    "--bundle",
    bundle,
    "--sha256",
    digest,
    "--mode",
    "live",
    "--output",
    `${root}/evaluation`,
    ...(baseline
      ? [
          "--baseline-bundle",
          baseline.bundle,
          "--baseline-sha256",
          baseline.digest,
          "--baseline-commit",
          baseline.commit,
        ]
      : ["--initial-baseline", retiredReleaseCommit]),
  ]);
  node("scripts/release/evidence.mjs", [
    "seal",
    "--evaluation",
    `${root}/evaluation`,
    "--profile",
    profileId,
    "--source-sha",
    env.GITHUB_SHA,
    "--bundle",
    bundle,
    "--bundle-sha256",
    digest,
    "--output",
    `${root}/candidate.json`,
    ...(baseline ? [] : ["--initial-baseline", retiredReleaseCommit]),
  ]);
  const candidateDigest = hash(await readFile(`${root}/candidate.json`));
  await writeFile(`${root}/candidate-sha256.txt`, candidateDigest + "\n");
  if (gh(`repos/${env.GITHUB_REPOSITORY}/git/ref/heads/release`).object.sha !== baselineCommit)
    throw new Error("Release changed during evaluation; rerun against the new baseline");
  node("scripts/release/archive.mjs", [
    "pack",
    `${root}/candidate.json`,
    "--sha256",
    candidateDigest,
    `${root}/release-evidence.json.gz`,
  ]);
  const run = await readRun(`${root}/evaluation`);
  const monitoring = {
    sourceSha: preflight.sourceSha,
    profile: run.manifest.profiles[0],
    entries: run.manifest.cases.map((spec) =>
      measuredEntry(
        spec,
        run.trials.find((trial) => trial.caseId === spec.id),
        run.manifest.profiles[0],
        run.manifest.policy,
      ),
    ),
  };
  const monitoringBytes = JSON.stringify(monitoring, null, 2) + "\n";
  await writeFile(`${root}/monitoring-baseline.json`, monitoringBytes);
  preflight.monitoringSha256 = hash(monitoringBytes);
  await writeFile(
    `${root}/receipt.json`,
    JSON.stringify(
      { ...preflight, bundleSha256: digest, candidateSha256: candidateDigest },
      null,
      2,
    ) + "\n",
  );
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
