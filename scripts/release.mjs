import { createHash } from "node:crypto";
import { readFile, writeFile, lstat, realpath, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, join, relative, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  readRun,
  baselineEvidence,
  assertFrozenImplementation,
  profiles,
  selectQualificationCases,
  compatibilityCases,
  validateReleaseArtifact,
} from "../evaluation/qualify.mjs";
import { verify as verifyBundle } from "./release-bundle.mjs";
import { fingerprints, configurationRecord } from "../evaluation/run.mjs";
import { policyForSuite, summarizeQualification } from "../evaluation/qualification-policy.mjs";
import { assertPilotReady } from "../evaluation/qualify.mjs";
import { compareTrials } from "../evaluation/release-comparison.mjs";
import { gradeTrial } from "../evaluation/grader.mjs";

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
async function optionalFile(path) {
  try {
    return await regular(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}
const relevant = (value) =>
  value.code
    ? { ...value, code: relevant(value.code) }
    : {
        ...value,
        files: Object.fromEntries(
          Object.entries(value.files).filter(([path]) => !path.includes("/bin/")),
        ),
      };
function fresh(value) {
  const time = Date.parse(value);
  ensure(
    Number.isFinite(time) && time <= Date.now() && Date.now() - time < 30 * 86400000,
    "Evidence timestamp is invalid or expired",
  );
}
function configuration(trial, profile, policy) {
  fresh(trial.createdAt);
  const recorded = configurationRecord(trial);
  ensure(
    isDeepStrictEqual(trial.configuration, recorded),
    "Recorded configuration differs from actual evidence",
  );
  ensure(
    typeof trial.evidence?.systemPrompt === "string" &&
      trial.evidence.systemPrompt.trim() &&
      typeof trial.evidence.outputSchema === "string" &&
      trial.evidence.outputSchema.trim(),
    "Actual prompt and schema evidence is required",
  );
  JSON.parse(trial.evidence.outputSchema);
  const request = recorded.effective?.request;
  ensure(
    trial.result?.contractVersion !== "4" || policy.requiredContractVersion === "4",
    "Contract 4 requires a separately frozen current-view qualification policy",
  );
  const promptVersion = {
    1: "5",
    2: "6",
    3: profile.variant === "concise" ? "7-concise-1" : "7",
    4: "8",
  }[trial.result?.contractVersion];
  ensure(typeof promptVersion === "string", "Unsupported release qualification contract");
  if (trial.result?.contractVersion === "4")
    ensure(
      profile.variant === "baseline" &&
        recorded.effective?.scope === "current_view" &&
        recorded.effective?.captureVersion === "5",
      "Current-view configuration mismatch",
    );
  ensure(
    /^[a-f\d]{64}$/.test(recorded.configurationId ?? "") &&
      recorded.model === profile.model &&
      recorded.provider === profile.provider &&
      recorded.promptVersion === promptVersion &&
      recorded.strategy === "candidate-selection-v1" &&
      recorded.effective?.responseCache === false &&
      request?.model === profile.model &&
      request.stream === false &&
      isDeepStrictEqual(request.plugins, [{ id: "context-compression", enabled: false }]) &&
      request.max_tokens === (trial.result?.contractVersion === "1" ? 512 : profile.maxTokens) &&
      isDeepStrictEqual(request.reasoning, profile.reasoning) &&
      isDeepStrictEqual(request.prompt_cache_options, profile.promptCacheOptions) &&
      isDeepStrictEqual(request.provider?.only, [profile.provider]) &&
      isDeepStrictEqual(request.provider?.order, [profile.provider]) &&
      request.provider?.allow_fallbacks === false &&
      request.provider?.require_parameters === true,
    "Actual configuration differs from approved profile",
  );
  return recorded;
}

async function evidence(options) {
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
    "Source identity environment overrides are not accepted",
  );
  const current = await fingerprints(process.cwd());
  const suitePath = options.suite ?? "evaluation/qualification-cases.json";
  ensure(
    [
      "evaluation/qualification-cases.json",
      "evaluation/current-view-qualification-cases.json",
    ].includes(suitePath),
    "Unsupported release suite",
  );
  const suite = await json(suitePath);
  const defaultPolicy = policyForSuite(suite);
  const files = {};
  const configurations = {};
  ensure(
    Boolean(options.bundle) === Boolean(options.bundleSha256),
    "Bundle directory and SHA-256 are required together",
  );
  let artifact;
  if (options.bundle) {
    const { manifest } = await verifyBundle(options.bundle, options.bundleSha256);
    artifact = validateReleaseArtifact(
      {
        version: 1,
        bundleManifestSha256: options.bundleSha256,
        sourceSha: manifest.sourceSha,
        profileId: manifest.profileId,
        images: manifest.images,
        platform: manifest.platform,
      },
      options.sourceSha,
      [options.profile],
    );
  }
  async function load(directory, phase) {
    directory = resolve(directory);
    ensure(
      (await lstat(directory)).isDirectory() && (await realpath(directory)) === directory,
      "Evidence directory cannot be a symlink",
    );
    const headerBytes = await regular(join(directory, "manifest.json"));
    const header = JSON.parse(headerBytes);
    const compatibilityBytes = await regular(join(directory, "compatibility.json"));
    const compatibility = JSON.parse(compatibilityBytes);
    const expectedCompatibility = compatibilityCases(
      suite.cases,
      defaultPolicy.requiredContractVersion ? header.cases : [],
    )
      .flatMap((s) => header.profiles.map((p) => `${s.id}:${p.id}`))
      .sort();
    ensure(
      Array.isArray(compatibility) &&
        isDeepStrictEqual(
          compatibility.map((r) => `${r.caseId}:${r.profileId}`).sort(),
          expectedCompatibility,
        ),
      "Incomplete or duplicate compatibility inventory",
    );
    const ids = header.plan?.trials
      ?.map((p) => p.id)
      ?.concat((compatibility ?? []).map((r) => r.id));
    ensure(
      Array.isArray(ids) &&
        ids.length > 0 &&
        ids.every((id) => typeof id === "string" && /^[a-f\d]{32}$/.test(id)) &&
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
    const snapshot = {
      "manifest.json": hash(headerBytes),
      "compatibility.json": hash(compatibilityBytes),
    };
    ensure(
      isDeepStrictEqual(header.qualification?.artifact, artifact),
      "Qualification artifact differs from supplied bundle",
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
        ensure(
          isDeepStrictEqual(
            baseline.profile,
            profiles.find((p) => p.id === baseline.profile.id),
          ),
          "Baseline profile differs from approved definition",
        );
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
    const summaryBytes = await optionalFile(join(directory, "summary.json"));
    const savedSummary = summaryBytes === null ? null : JSON.parse(summaryBytes);
    if (summaryBytes !== null) snapshot["summary.json"] = hash(summaryBytes);
    ensure(
      !(await readdir(directory)).includes("run-error.json"),
      "Qualification run recorded an operational failure",
    );
    for (const record of compatibility ?? []) {
      const spec = suite.cases.find((s) => s.id === record.caseId);
      const trial = await json(join(directory, "trials", `${record.id}.json`));
      ensure(
        spec &&
          (spec.split !== "held-out" || defaultPolicy.requiredContractVersion === "4") &&
          trial.mode === "deterministic" &&
          record.id === trial.id &&
          record.caseId === trial.caseId &&
          record.profileId === trial.profileId &&
          header.profiles.some((p) => p.id === record.profileId),
        "Invalid compatibility trial identity",
      );
      const grade = gradeTrial(spec, trial);
      if (header.comparison)
        ensure(
          trial.baseline?.mode === "deterministic" && gradeTrial(spec, trial.baseline).passed,
          "Baseline compatibility failed",
        );
      ensure(
        grade.passed && isDeepStrictEqual(grade, record.grade),
        "Compatibility evidence failed replay",
      );
    }
    const run = await readRun(directory);
    const m = run.manifest;
    ensure(isDeepStrictEqual(m, header), "Evidence changed during verification");
    fresh(m.createdAt);
    ensure(
      m.mode === "live" && m.phase === phase && m.code.revision === options.sourceSha,
      "Run phase, mode or source mismatch",
    );
    ensure(/^[a-f\d]{64}$/.test(m.browserBinarySha256 ?? ""), "Missing browser binary fingerprint");
    ensure(
      isDeepStrictEqual(m.policy, defaultPolicy) &&
        m.qualification?.policySha256 === hash(defaultPolicy),
      "Qualification policy differs from current policy",
    );
    ensure(m.code.tree === current.tree, "Source tree differs from recorded source");
    assertFrozenImplementation(relevant(current), relevant(m.code));
    ensure(
      m.sourceManifestHash === hash(suite),
      "Qualification suite differs from current reviewed suite",
    );
    const selection = selectQualificationCases(suite.cases, {
      mode: "live",
      splits: phase === "pilot" ? ["development"] : defaultPolicy.requiredSplits,
      requiredContractVersion: defaultPolicy.requiredContractVersion,
    });
    ensure(
      isDeepStrictEqual(m.cases, selection.cases) &&
        isDeepStrictEqual(m.exclusions, selection.exclusions),
      "Run does not cover the complete eligible reviewed suite",
    );
    ensure(
      Number.isSafeInteger(m.plan.repetitions) &&
        m.plan.repetitions > 0 &&
        m.plan.repetitions <= 100,
      "Invalid qualification plan repetitions",
    );
    const expectedPlan = m.cases
      .flatMap((s) =>
        m.profiles.flatMap((p) =>
          Array.from({ length: m.plan.repetitions }, (_, i) => `${s.id}:${p.id}:${i + 1}:1`),
        ),
      )
      .sort();
    ensure(
      isDeepStrictEqual(
        m.plan.trials.map((p) => `${p.caseId}:${p.profileId}:${p.repetition}:${p.attempt}`).sort(),
        expectedPlan,
      ) && isDeepStrictEqual([...m.plan.caseOrder].sort(), m.cases.map((s) => s.id).sort()),
      "Incomplete or duplicate qualification plan",
    );
    ensure(
      m.cases.every(
        (spec) =>
          spec.review?.status === "reviewed" &&
          typeof spec.review.reviewer === "string" &&
          spec.review.reviewer.trim() &&
          Number.isFinite(Date.parse(spec.review.reviewedAt)),
      ),
      "Case labels require independent review",
    );
    for (const profile of m.profiles)
      ensure(
        isDeepStrictEqual(
          profile,
          profiles.find((p) => p.id === profile.id),
        ),
        "Profile settings differ from approved definition",
      );
    ensure(
      m.profiles.some((p) => p.id === options.profile),
      "Selected profile is absent",
    );
    for (const id of ids) {
      const trial = await json(join(directory, "trials", `${id}.json`));
      const profile = m.profiles.find((p) => p.id === trial.profileId);
      ensure(profile, "Trial references an unknown profile");
      const record = configuration(trial, profile, defaultPolicy);
      const key = `${profile.id}:${trial.result.contractVersion}`;
      ensure(
        !configurations[key] || isDeepStrictEqual(configurations[key], record),
        "Configuration changed within profile and contract",
      );
      configurations[key] = record;
      if (m.comparison) {
        ensure(
          trial.baseline?.caseId === trial.caseId && trial.baseline?.mode === trial.mode,
          "Baseline trial identity differs",
        );
        const baselineRecord = configuration(trial.baseline, m.comparison.profile, defaultPolicy);
        const baselineKey = `release-baseline:${trial.result.contractVersion}`;
        ensure(
          !configurations[baselineKey] ||
            isDeepStrictEqual(configurations[baselineKey], baselineRecord),
          "Baseline configuration changed during comparison",
        );
        configurations[baselineKey] = baselineRecord;
      }
    }
    const summary = summarizeQualification(m, run.trials, defaultPolicy);
    if (summaryBytes !== null)
      ensure(isDeepStrictEqual(savedSummary, summary), "Saved summary differs from replay");
    ensure(
      isDeepStrictEqual(
        (await readdir(join(directory, "trials"))).sort(),
        ids.map((id) => `${id}.json`).sort(),
      ) && !(await readdir(directory)).includes("run-error.json"),
      "Evidence changed during verification",
    );
    for (const [path, digest] of Object.entries(snapshot)) {
      ensure(
        hash(await regular(join(directory, path))) === digest,
        "Evidence changed during verification",
      );
      files[join(directory, path)] = digest;
    }
    ensure(
      (await optionalFile(join(directory, "summary.json"))) === null
        ? summaryBytes === null
        : summaryBytes !== null,
      "Evidence changed during verification",
    );
    return { ...run, summary };
  }
  const pilot = await load(options.pilot, "pilot");
  const confirmation = await load(options.confirmation, "confirmation");
  if (defaultPolicy.version === "4") {
    ensure(
      artifact && pilot.manifest.comparison && confirmation.manifest.comparison,
      "Relative qualification requires exact candidate and baseline artifacts",
    );
    assertPilotReady(pilot);
    ensure(
      compareTrials(confirmation.manifest, confirmation.trials, defaultPolicy).status === "passed",
      "Candidate regresses against baseline",
    );
  }
  const exposure = confirmation.manifest.qualification.exposure;
  if (["3", "4"].includes(defaultPolicy.version))
    ensure(
      exposure?.runId === confirmation.manifest.id &&
        exposure.sourceSha === options.sourceSha &&
        /^[\w.-]+\/[\w.-]+$/.test(exposure.repository ?? "") &&
        Number.isFinite(Date.parse(exposure.reservedAt)) &&
        Date.parse(exposure.reservedAt) <=
          Date.parse(confirmation.manifest.qualification.heldOutStartedAt) &&
        isDeepStrictEqual(
          exposure.families,
          [
            ...new Set(
              confirmation.manifest.cases
                .filter((c) => c.split === "held-out")
                .map((c) => c.family),
            ),
          ].sort(),
        ),
      "Confirmation lacks its exact held-out exposure reservation",
    );
  assertFrozenImplementation(relevant(confirmation.manifest), relevant(pilot.manifest));
  ensure(
    isDeepStrictEqual(confirmation.manifest.baselineEvidence, baselineEvidence(pilot)),
    "Confirmation baseline differs from actual pilot",
  );
  ensure(
    isDeepStrictEqual(confirmation.manifest.qualification.baselineRunIds, [pilot.manifest.id]),
    "Confirmation does not bind the actual pilot",
  );
  ensure(
    confirmation.summary.profiles[options.profile]?.qualification.status === "qualified",
    "Selected candidate is not qualified",
  );
  ensure(
    git("rev-parse", "HEAD") === options.sourceSha &&
      !git("status", "--porcelain", "--untracked-files=all"),
    "Source changed during verification",
  );
  const finalSource = await fingerprints(process.cwd());
  ensure(finalSource.tree === current.tree, "Source changed during verification");
  assertFrozenImplementation(relevant(finalSource), relevant(current));
  for (const [path, digest] of Object.entries(files))
    ensure(hash(await regular(path)) === digest, "Evidence changed during verification");
  const portable = options.version !== 1;
  const evidencePath = (path) => {
    if (!portable) return resolve(path);
    const value = relative(process.cwd(), resolve(path));
    ensure(
      value.startsWith(".artifacts/") && !isAbsolute(value) && !value.split("/").includes(".."),
      "Portable evidence must remain under this checkout's .artifacts directory",
    );
    return value;
  };
  return {
    version: portable ? 2 : 1,
    status: artifact ? "artifact-bound-evidence-verified" : "evidence-only-verified",
    defaultActivated: false,
    sourceSha: options.sourceSha,
    ...(options.suite ? { suite: options.suite } : {}),
    profile: options.profile,
    ...(confirmation.manifest.comparison ? { comparison: confirmation.manifest.comparison } : {}),
    pilot: evidencePath(options.pilot),
    confirmation: evidencePath(options.confirmation),
    ...(artifact
      ? { bundle: evidencePath(options.bundle), bundleSha256: options.bundleSha256, artifact }
      : {}),
    policySha256: hash(defaultPolicy),
    browserBinarySha256: confirmation.manifest.browserBinarySha256,
    ...(exposure ? { exposure } : {}),
    configurations,
    files: Object.fromEntries(
      Object.entries(files).map(([path, digest]) => [evidencePath(path), digest]),
    ),
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "verify") {
    const [file, flag, digest] = args;
    ensure(
      args.length === 3 && flag === "--sha256" && /^[a-f\d]{64}$/.test(digest ?? ""),
      "Use verify FILE --sha256 EXPECTED_DIGEST",
    );
    const bytes = await regular(file);
    ensure(hash(bytes) === digest, "Candidate SHA-256 mismatch");
    const candidate = JSON.parse(bytes);
    ensure(isDeepStrictEqual(candidate, await evidence(candidate)), "Candidate evidence changed");
    console.log("Candidate evidence verified; runtime default unchanged.");
    return;
  }
  const names = {
    "--confirmation": "confirmation",
    "--pilot": "pilot",
    "--profile": "profile",
    "--source-sha": "sourceSha",
    "--output": "output",
    "--bundle": "bundle",
    "--bundle-sha256": "bundleSha256",
    "--suite": "suite",
  };
  const options = {};
  ensure(
    command === "seal" && [10, 12, 14, 16].includes(args.length),
    "Use seal --confirmation RUN --pilot PILOT --profile ID --source-sha SHA --output FILE [--bundle DIRECTORY --bundle-sha256 DIGEST]",
  );
  for (let i = 0; i < args.length; i += 2) {
    ensure(
      names[args[i]] && args[i + 1] && !Object.hasOwn(options, names[args[i]]),
      "Invalid or duplicate release option",
    );
    options[names[args[i]]] = args[i + 1];
  }
  ensure(
    ["confirmation", "pilot", "profile", "sourceSha", "output"].every((name) => options[name]),
    "Missing required release option",
  );
  const candidate = await evidence(options);
  const bytes = JSON.stringify(candidate, null, 2) + "\n";
  await writeFile(options.output, bytes, { flag: "wx", mode: 0o600 });
  console.log(
    `Candidate evidence sealed; retain SHA-256 ${hash(bytes)} independently. Runtime default unchanged.`,
  );
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
