import { retiredReleaseCommit, assertSameSourceTree } from "./baseline.mjs";
import { createHash } from "node:crypto";
import { readFile, writeFile, lstat, realpath, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  readRun,
  profiles,
  selectQualificationCases,
  validateReleaseArtifact,
} from "../../evaluation/compare.mjs";
import { verify as verifyBundle } from "./bundle.mjs";
import { fingerprints, configurationRecord } from "../../evaluation/run.mjs";
import { defaultPolicy, summarizeQualification } from "../../evaluation/policy.mjs";
import { loadCases } from "../../evaluation/cases/load.mjs";
import { readCollection } from "../../evaluation/datasets/collection.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");
const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
async function regular(path) {
  ensure(
    (await lstat(path)).isFile() && (await realpath(path)) === resolve(path),
    "Evidence must be a regular file without symlinks",
  );
  return readFile(path);
}
const json = async (path) => JSON.parse(await regular(path));
function fresh(value) {
  const time = Date.parse(value);
  ensure(
    Number.isFinite(time) && time <= Date.now() && Date.now() - time < 30 * 86400000,
    "Evidence timestamp is invalid or expired",
  );
}
function portable(path) {
  const value = relative(process.cwd(), resolve(path));
  ensure(
    /^\.artifacts\/[a-zA-Z0-9_./-]+$/.test(value) && !value.split("/").includes(".."),
    "Evidence must be under this checkout's .artifacts directory",
  );
  return value;
}
export async function evidence(options) {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  ensure(
    /^[a-f\d]{40}$/.test(options.sourceSha ?? "") && git("rev-parse", "HEAD") === options.sourceSha,
    "Source SHA differs from actual checkout",
  );
  ensure(
    !git("status", "--porcelain", "--untracked-files=all"),
    "Release evidence requires a clean checkout",
  );
  ensure(
    !process.env.XPATHED_CODE_REVISION &&
      !process.env.XPATHED_TREE_HASH &&
      !process.env.XPATHED_WORKSPACE,
    "Source identity overrides are not accepted",
  );
  const current = await fingerprints(process.cwd());
  const suitePath = "evaluation/cases/index.json";
  const suite = loadCases(suitePath);
  suite.cases.push(...readCollection());
  const { manifest: bundle } = await verifyBundle(options.bundle, options.bundleSha256);
  const artifact = validateReleaseArtifact(
    {
      version: 1,
      bundleManifestSha256: options.bundleSha256,
      sourceSha: bundle.sourceSha,
      profileId: options.profile,
      images: bundle.images,
      platform: bundle.platform,
    },
    options.sourceSha,
    [options.profile],
  );
  const directory = resolve(options.evaluation);
  ensure(
    (await lstat(directory)).isDirectory() && (await realpath(directory)) === directory,
    "Evidence directory cannot be a symlink",
  );
  const headerBytes = await regular(join(directory, "manifest.json"));
  const header = JSON.parse(headerBytes);
  const ids = header.plan?.trials?.map((trial) => trial.id);
  ensure(
    Array.isArray(ids) &&
      ids.length &&
      ids.every((id) => /^[a-f\d]{32}$/.test(id)) &&
      new Set(ids).size === ids.length,
    "Invalid trial identity",
  );
  ensure(
    isDeepStrictEqual(
      (await readdir(join(directory, "trials"))).sort(),
      ids.map((id) => `${id}.json`).sort(),
    ),
    "Missing or extra trial files",
  );
  const snapshot = { "manifest.json": hash(headerBytes) };
  ensure(
    isDeepStrictEqual(header.qualification?.artifact, artifact) &&
      (header.comparison ||
        (options.initialBaseline === retiredReleaseCommit &&
          header.initialBaseline === retiredReleaseCommit)),
    "Exact candidate and release baseline artifacts are required",
  );
  if (artifact) {
    const beforeBytes = await regular(join(directory, "artifact-before.json"));
    const receiptBytes = await regular(join(directory, "artifact-receipt.json"));
    const before = JSON.parse(beforeBytes),
      receipt = JSON.parse(receiptBytes);
    const expectedKeys = (value, keys) =>
      value && isDeepStrictEqual(Object.keys(value).sort(), keys.sort());
    const observed = (value, expectedArtifact = artifact) =>
      Array.isArray(value) &&
      value.length === 2 &&
      value.every(
        (item, index) =>
          expectedKeys(item, ["component", "imageId", "containerId"]) &&
          item.component === expectedArtifact.images[index].component &&
          item.imageId === expectedArtifact.images[index].id &&
          /^[a-f\d]{64}$/.test(item.containerId ?? ""),
      ) &&
      value[0].containerId !== value[1].containerId;
    ensure(
      expectedKeys(before, [
        "version",
        "artifact",
        "observed",
        ...(header.comparison ? ["comparison", "baselineObserved"] : []),
      ]) &&
        before.version === 1 &&
        expectedKeys(receipt, [
          "version",
          "artifact",
          "before",
          "after",
          ...(header.comparison ? ["comparison", "baselineBefore", "baselineAfter"] : []),
        ]) &&
        receipt.version === 1 &&
        isDeepStrictEqual(before.artifact, artifact) &&
        isDeepStrictEqual(receipt.artifact, artifact) &&
        observed(before.observed) &&
        observed(receipt.before) &&
        observed(receipt.after) &&
        isDeepStrictEqual(before.observed, receipt.before) &&
        isDeepStrictEqual(receipt.before, receipt.after),
      "Artifact container attestation is missing or mismatched",
    );
    if (header.comparison) {
      const baseline = header.comparison;
      assertSameSourceTree(baseline.commit, baseline.artifact.sourceSha);
      validateReleaseArtifact(baseline.artifact, baseline.artifact.sourceSha, [
        baseline.profile.id,
      ]);
      ensure(
        isDeepStrictEqual(before.comparison, baseline) &&
          isDeepStrictEqual(receipt.comparison, baseline) &&
          observed(before.baselineObserved, baseline.artifact) &&
          observed(receipt.baselineBefore, baseline.artifact) &&
          observed(receipt.baselineAfter, baseline.artifact) &&
          isDeepStrictEqual(before.baselineObserved, receipt.baselineBefore) &&
          isDeepStrictEqual(receipt.baselineBefore, receipt.baselineAfter),
        "Baseline image attestation differs",
      );
    }
    snapshot["artifact-before.json"] = hash(beforeBytes);
    snapshot["artifact-receipt.json"] = hash(receiptBytes);
  }

  for (const id of ids)
    snapshot[`trials/${id}.json`] = hash(await regular(join(directory, "trials", `${id}.json`)));
  ensure(
    !(await readdir(directory)).includes("run-error.json"),
    "Evaluation recorded an operational failure",
  );
  const run = await readRun(directory),
    m = run.manifest;
  ensure(isDeepStrictEqual(m, header), "Evidence changed during verification");
  fresh(m.createdAt);
  ensure(
    m.mode === "live" &&
      !m.monitoring &&
      m.code.revision === options.sourceSha &&
      m.code.tree === current.tree,
    "Evaluation source or mode mismatch",
  );
  for (const [path, digest] of Object.entries(current.files).filter(
    ([path]) => !path.includes("/bin/"),
  ))
    ensure(m.code.files[path] === digest, `Evaluation implementation changed: ${path}`);
  ensure(/^[a-f\d]{64}$/.test(m.browserBinarySha256 ?? ""), "Missing Chromium identity");
  ensure(
    isDeepStrictEqual(m.policy, defaultPolicy) &&
      m.qualification.policySha256 === hash(defaultPolicy),
    "Policy differs from current policy",
  );
  ensure(m.sourceManifestHash === hash(suite), "Case collection differs from reviewed collection");
  const selection = selectQualificationCases(suite.cases);
  ensure(
    isDeepStrictEqual(m.cases, selection.cases) &&
      isDeepStrictEqual(m.exclusions, selection.exclusions),
    "Incomplete release case collection",
  );
  ensure(
    isDeepStrictEqual(m.profiles, [profiles.find((profile) => profile.id === options.profile)]),
    "Candidate profile differs",
  );
  const configurations = {};
  const tracks = new Map(m.cases.map((spec) => [spec.id, spec.track ?? "browser"]));
  for (const trial of run.trials) {
    for (const [arm, profile] of [
      [trial, m.profiles[0]],
      ...(m.comparison ? [[trial.baseline, m.comparison.profile]] : []),
    ]) {
      fresh(arm.createdAt);
      ensure(
        Date.parse(arm.createdAt) >= Date.parse(m.qualification.frozenAt),
        "Inference predates frozen cases and policy",
      );
      const record = configurationRecord(arm);
      const request = record.effective?.request;
      ensure(
        isDeepStrictEqual(arm.configuration, record) &&
          typeof arm.evidence?.systemPrompt === "string" &&
          typeof arm.evidence?.outputSchema === "string",
        "Configuration evidence missing or changed",
      );
      JSON.parse(arm.evidence.outputSchema);
      ensure(
        record.model === profile.model &&
          record.provider === profile.provider &&
          request?.model === profile.model &&
          request.stream === false &&
          record.effective.responseCache === false &&
          isDeepStrictEqual(request.provider?.only, [profile.provider]) &&
          request.provider.allow_fallbacks === false &&
          request.max_tokens === profile.maxTokens &&
          isDeepStrictEqual(request.reasoning, profile.reasoning),
        "Observed configuration differs from tested profile",
      );
      const key = `${arm === trial ? profile.id : "release-baseline"}:${tracks.get(trial.caseId)}`;
      ensure(
        !configurations[key] || isDeepStrictEqual(configurations[key], record),
        "Configuration changed within an arm",
      );
      configurations[key] = record;
    }
  }
  const summary = summarizeQualification(m, run.trials, defaultPolicy);
  ensure(
    summary.qualifiedCandidates.includes(options.profile),
    "Candidate lost a baseline pass or evaluation evidence failed",
  );
  const summaryBytes = await regular(join(directory, "summary.json"));
  ensure(isDeepStrictEqual(JSON.parse(summaryBytes), summary), "Saved summary differs from replay");
  snapshot["summary.json"] = hash(summaryBytes);
  const files = {};
  for (const [path, digest] of Object.entries(snapshot)) {
    const full = join(directory, path);
    ensure(hash(await regular(full)) === digest, "Evidence changed during verification");
    files[portable(full)] = digest;
  }
  ensure(
    git("rev-parse", "HEAD") === options.sourceSha &&
      !git("status", "--porcelain", "--untracked-files=all") &&
      (await fingerprints(process.cwd())).tree === current.tree,
    "Source changed during verification",
  );
  return {
    version: 3,
    status: "artifact-bound-evidence-verified",
    ...(m.initialBaseline ? { initialBaseline: m.initialBaseline } : {}),
    sourceSha: options.sourceSha,
    sourceTree: git("rev-parse", "HEAD^{tree}"),
    suite: suitePath,
    profile: options.profile,
    ...(m.comparison ? { comparison: m.comparison } : {}),
    evaluation: portable(options.evaluation),
    bundle: portable(options.bundle),
    bundleSha256: options.bundleSha256,
    artifact,
    policySha256: hash(defaultPolicy),
    browserBinarySha256: m.browserBinarySha256,
    configurations,
    files,
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "verify") {
    const [file, flag, digest] = args;
    ensure(
      args.length === 3 && flag === "--sha256" && /^[a-f\d]{64}$/.test(digest ?? ""),
      "Use verify FILE --sha256 DIGEST",
    );
    const bytes = await regular(file);
    ensure(hash(bytes) === digest, "Candidate digest mismatch");
    const candidate = JSON.parse(bytes);
    ensure(isDeepStrictEqual(candidate, await evidence(candidate)), "Candidate evidence changed");
    console.log("Exact candidate evidence verified.");
    return;
  }
  ensure(command === "seal" && args.length % 2 === 0, "Use seal with named options");
  const names = {
      "--evaluation": "evaluation",
      "--profile": "profile",
      "--source-sha": "sourceSha",
      "--bundle": "bundle",
      "--bundle-sha256": "bundleSha256",
      "--output": "output",
      "--initial-baseline": "initialBaseline",
    },
    options = {};
  for (let i = 0; i < args.length; i += 2) {
    ensure(
      names[args[i]] && args[i + 1] && !options[names[args[i]]],
      "Unknown, duplicate or missing release option",
    );
    options[names[args[i]]] = args[i + 1];
  }
  ensure(
    Object.values(names)
      .filter((name) => name !== "initialBaseline")
      .every((name) => options[name]),
    "Missing release option",
  );
  const bytes = JSON.stringify(await evidence(options), null, 2) + "\n";
  await writeFile(options.output, bytes, { flag: "wx", mode: 0o600 });
  console.log(`Candidate evidence sealed: ${hash(bytes)}`);
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
