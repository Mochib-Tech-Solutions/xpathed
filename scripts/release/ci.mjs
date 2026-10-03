import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { profiles, selectQualificationCases } from "../../evaluation/compare.mjs";
import { validateCases } from "../../evaluation/run.mjs";
import { loadCases } from "../../evaluation/cases/load.mjs";
import { readCollection } from "../../evaluation/datasets/collection.mjs";
import { prepareBaseline } from "./baseline.mjs";
import { readState } from "./state.mjs";
const gh = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));
const node = (script, args) =>
  execFileSync(process.execPath, [script, ...args], { stdio: "inherit" });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function qualificationCoverage(suite) {
  const { cases } = selectQualificationCases(validateCases(suite));
  const blockers = cases.some(
    (spec) =>
      spec.review?.status !== "reviewed" ||
      !spec.review.reviewer?.trim() ||
      !Number.isFinite(Date.parse(spec.review.reviewedAt)),
  )
    ? ["Every live case requires independently reviewed labels"]
    : [];
  return { ready: !blockers.length, cases: cases.length, blockers };
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
export async function requireCI(repository, sha, waitMs = 0, api = gh) {
  const deadline = Date.now() + waitMs;
  do {
    const checks = api(`repos/${repository}/commits/${sha}/check-runs?per_page=100`).check_runs;
    const check = checks
      .filter((check) => check.name === "Check" && check.app?.slug === "github-actions")
      .sort((a, b) => b.id - a.id)[0];
    if (check?.conclusion === "success") return;
    if (check?.status === "completed" || Date.now() >= deadline)
      throw new Error(
        "Ordinary CI must pass for the exact tested source before release evaluation",
      );
    await delay(10000);
  } while (true);
}
export function caseChanges(previous, current) {
  const fields = [
    "contractVersion",
    "track",
    "instruction",
    "fixture",
    "setupRevision",
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
  const env = process.env,
    [profileId = "deepseek"] = process.argv.slice(2);
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
  await requireCI(env.GITHUB_REPOSITORY, env.GITHUB_SHA, 30 * 60000);
  const root = ".artifacts/release-ci";
  await mkdir(root, { recursive: true, mode: 0o700 });
  const suite = loadCases();
  suite.cases.push(...readCollection());
  const coverage = qualificationCoverage(suite);
  if (!coverage.ready) throw new Error(coverage.blockers.join("; "));
  const releaseState = readState(env.GITHUB_REPOSITORY);
  const preflight = {
    sourceSha: env.GITHUB_SHA,
    sourceTree: git("rev-parse", "HEAD^{tree}"),
    pr: event.number,
    headSha: event.pull_request.head.sha,
    mode: "live",
    profileId,
    coverage,
  };
  await writeFile(`${root}/preflight.json`, JSON.stringify(preflight, null, 2) + "\n");
  const bundle = `${root}/bundle`;
  node("scripts/release/bundle.mjs", [
    "create",
    "--profile",
    profileId,
    "--source-sha",
    env.GITHUB_SHA,
    "--output",
    bundle,
  ]);
  const digest = hash(await readFile(`${bundle}/manifest.json`));
  await writeFile(`${root}/bundle-sha256.txt`, digest + "\n");
  const baseline = await prepareBaseline(releaseState, `${root}/baseline`);
  await writeFile(
    `${root}/case-changes.json`,
    JSON.stringify(
      caseChanges(baseline.cases, selectQualificationCases(suite.cases).cases),
      null,
      2,
    ) + "\n",
  );
  node("scripts/release/evaluate.mjs", [
    "--bundle",
    bundle,
    "--sha256",
    digest,
    "--mode",
    "live",
    "--profile",
    profileId,
    "--output",
    `${root}/evaluation`,
    "--baseline-bundle",
    baseline.bundle,
    "--baseline-sha256",
    baseline.digest,
    "--baseline-approval",
    baseline.approval,
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
  ]);
  const candidateDigest = hash(await readFile(`${root}/candidate.json`));
  await writeFile(`${root}/candidate-sha256.txt`, candidateDigest + "\n");
  node("scripts/release/archive.mjs", [
    "pack",
    `${root}/candidate.json`,
    "--sha256",
    candidateDigest,
    `${root}/release-evidence.json.gz`,
  ]);
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
