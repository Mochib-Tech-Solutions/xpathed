import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { profiles, selectQualificationCases } from "../evaluation/qualify.mjs";
import { validateCases } from "../evaluation/run.mjs";
import policy from "../evaluation/qualification-policy.json" with { type: "json" };

export async function checkEvaluationKey(key, fetchImpl = fetch) {
  if (!key) throw new Error("Missing evaluation key");
  let data;
  try {
    const response = await fetchImpl("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Unusable key metadata response");
    ({ data } = await response.json());
  } catch {
    throw new Error("Evaluation key metadata unavailable");
  }
  if (
    !data ||
    data.is_management_key !== false ||
    (data.expires_at != null && !(Date.parse(data.expires_at) > Date.now()))
  )
    throw new Error("Evaluation key must be a valid unexpired inference key, not a management key");
  return {
    limitUsd: Number.isFinite(data.limit) ? data.limit : null,
    remainingUsd: Number.isFinite(data.limit_remaining) ? data.limit_remaining : null,
    reset: ["daily", "weekly", "monthly"].includes(data.limit_reset) ? data.limit_reset : null,
    expiresAt: data.expires_at ?? null,
  };
}

export function qualificationCoverage(suite) {
  const all = validateCases(suite);
  const { cases } = selectQualificationCases(all, {
    mode: "live",
    splits: ["development", ...policy.requiredSplits],
  });
  const held = cases.filter((c) => c.split === "held-out");
  const families = new Set(held.map((c) => c.family));
  const exposed = new Set(all.filter((c) => c.split !== "held-out").map((c) => c.family));
  const blockers = [];
  if (all.some((c) => c.contractVersion === "4"))
    blockers.push("Contract 4 requires a separately frozen current-view qualification policy");
  if (held.length < policy.minimumHeldOutTrials || families.size < policy.minimumHeldOutFamilies)
    blockers.push(
      `Fresh held-out coverage requires at least ${policy.minimumHeldOutTrials} cases across ${policy.minimumHeldOutFamilies} families (one attempt each)`,
    );
  if (
    held.some(
      (c) =>
        c.previousSplit != null ||
        c.exposureRunId != null ||
        c.exposureRuns != null ||
        exposed.has(c.family),
    )
  )
    blockers.push("Held-out families have previous exposure or overlap with another split");
  if (
    ["development", ...policy.requiredSplits].some((split) => !cases.some((c) => c.split === split))
  )
    blockers.push("Every required split and the development pilot must be present");
  if (
    cases.some(
      (c) =>
        c.review?.status !== "reviewed" ||
        !c.review.reviewer?.trim() ||
        !Number.isFinite(Date.parse(c.review.reviewedAt)),
    )
  )
    blockers.push("Every eligible case needs independently reviewed labels");
  if (cases.some((c) => c.capabilityGap))
    blockers.push("Known capability gaps remain in the declared qualification scope");
  return {
    ready: blockers.length === 0,
    heldOutCases: held.length,
    heldOutFamilies: families.size,
    blockers,
  };
}

async function main() {
  const [mode, profileId] = process.argv.slice(2);
  const env = process.env;
  if (
    process.argv.length !== 4 ||
    !["preflight", "deterministic", "live"].includes(mode) ||
    !profiles.some((p) => p.id === profileId)
  )
    throw new Error("Use release-ci.mjs preflight|deterministic|live PROFILE");
  if (
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    !/^[a-f\d]{40}$/.test(env.GITHUB_SHA ?? "") ||
    !/^\d+$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? "")
  )
    throw new Error("Release workflow requires a trusted manual main-branch dispatch");
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  if (
    git("rev-parse", "HEAD") !== env.GITHUB_SHA ||
    git("status", "--porcelain", "--untracked-files=all")
  )
    throw new Error("Release workflow requires the exact clean dispatched revision");
  const root = ".artifacts/release-ci";
  await mkdir(root, { recursive: true, mode: 0o700 });
  const coverage = qualificationCoverage(
    JSON.parse(await readFile("evaluation/qualification-cases.json", "utf8")),
  );
  const report = {
    sourceSha: env.GITHUB_SHA,
    mode,
    profileId,
    coverage,
    defaultActivated: false,
    scheduledMonitoring: false,
  };
  const save = () =>
    writeFile(`${root}/preflight.json`, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  await save();
  if (mode !== "deterministic") {
    const { githubBudget } = await import("../evaluation/github-budget.mjs");
    const { readEvaluationKey, validateBudgetLedger } =
      await import("../evaluation/comparison-budget.mjs");
    if (
      env.XPATHED_BUDGET_GITHUB_REPOSITORY?.toLowerCase() !== env.GITHUB_REPOSITORY?.toLowerCase()
    )
      throw new Error("Budget authority must be this private repository");
    const remote = await githubBudget(env.XPATHED_BUDGET_GITHUB_REPOSITORY, env.GH_TOKEN);
    if (remote.ledger.budgetPolicy !== "provider-limit")
      throw new Error("Evaluation ledger requires an explicit provider-limit policy migration");
    validateBudgetLedger(remote.ledger);
    const unknown = remote.ledger.entries.filter((entry) => entry.reportedUsd == null);
    report.budget = {
      budgetPolicy: "provider-limit",
      historicalCeilingUsd: remote.ledger.ceilingUsd ?? null,
      ceilingUsd: null,
      remainingUsd: null,
      knownReportedUsd: remote.ledger.entries.reduce(
        (sum, entry) => sum + (entry.reportedUsd ?? 0),
        0,
      ),
      unknownChargeRecords: unknown.length,
      unknownReservedUsd: unknown.reduce((sum, entry) => sum + (entry.reservedUsd ?? 0), 0),
      unknownEstimateRecords: unknown.filter((entry) => entry.reservedUsd == null).length,
    };
    report.key = await checkEvaluationKey(await readEvaluationKey(env));
    await save();
  }
  console.log(JSON.stringify(report, null, 2));
  if (mode === "preflight") return;
  if (mode === "live" && !coverage.ready)
    throw new Error(`Qualification blocked before inference: ${coverage.blockers.join("; ")}`);
  const node = (script, args) =>
    execFileSync(process.execPath, [script, ...args], { stdio: "inherit" });
  const bundle = `${root}/bundle`;
  node("scripts/release-bundle.mjs", [
    "create",
    "--profile",
    profileId,
    "--source-sha",
    env.GITHUB_SHA,
    "--output",
    bundle,
  ]);
  const digest = createHash("sha256")
    .update(await readFile(`${bundle}/manifest.json`))
    .digest("hex");
  await writeFile(`${root}/bundle-sha256.txt`, digest + "\n", { mode: 0o600 });
  const evaluate = (phase, split, output, extra = []) =>
    node("scripts/release-evaluate.mjs", [
      "--bundle",
      bundle,
      "--sha256",
      digest,
      "--mode",
      mode,
      "--profile",
      profileId,
      "--phase",
      phase,
      "--split",
      split,
      "--repetitions",
      "1",
      "--output",
      output,
      ...extra,
    ]);
  const pilot = `${root}/pilot`,
    confirmation = `${root}/confirmation`;
  if (mode === "deterministic") {
    evaluate("pilot", "development,regression", `${root}/deterministic`);
    return;
  }
  evaluate("pilot", "development", pilot);
  evaluate("confirmation", policy.requiredSplits.join(","), confirmation, ["--pilot", pilot]);
  node("scripts/release.mjs", [
    "seal",
    "--pilot",
    pilot,
    "--confirmation",
    confirmation,
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
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
