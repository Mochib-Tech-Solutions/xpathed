import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { makeCase } from "./offline.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const dispositions = new Set([
  "validated",
  "incorrect",
  "ambiguous",
  "evidence_insufficient",
  "unresolved",
]);

export function validateLabelReview(spec, review = spec.labelReview) {
  const candidates = spec.input?.candidates;
  const actions = spec.expected?.actions;
  if (
    !review ||
    review.caseId !== spec.id ||
    !dispositions.has(review.disposition) ||
    review.inputHash !== hash(JSON.stringify(spec.input)) ||
    review.labelHash !== hash(JSON.stringify(spec.expected)) ||
    typeof review.reason !== "string" ||
    !review.reason.trim() ||
    typeof review.reviewer !== "string" ||
    !review.reviewer.trim() ||
    !Number.isFinite(Date.parse(review.reviewedAt)) ||
    spec.instruction !== spec.input?.instruction ||
    !Array.isArray(candidates) ||
    candidates.some((item) => !item || typeof item.id !== "string" || !item.id.trim()) ||
    new Set(candidates.map((item) => item.id)).size !== candidates.length ||
    !Array.isArray(actions) ||
    actions.length !== 1 ||
    actions[0]?.outcome !== "found" ||
    typeof actions[0].target?.candidateId !== "string" ||
    !actions[0].target.candidateId.trim() ||
    !candidates.some((item) => item.id === actions[0].target?.candidateId)
  )
    throw new Error(
      "Dataset label review is missing, invalid or does not bind the input and expected target",
    );
  return review;
}

export function labelExclusions(cases, caseId) {
  return cases.flatMap((spec) => {
    const review = validateLabelReview(spec);
    if (review.disposition !== "validated")
      return [{ caseId: spec.id, reason: `label ${review.disposition}: ${review.reason}` }];
    return caseId && caseId !== spec.id ? [{ caseId: spec.id, reason: "case filter" }] : [];
  });
}

export function readCollection(
  configPath = new URL("./collection.json", import.meta.url),
  root = process.env.XPATHED_WORKSPACE || process.cwd(),
) {
  const config = json(configPath);
  const bytes = readFileSync(resolve(root, config.path));
  if (hash(bytes) !== config.sha256) throw new Error("Reviewed dataset package digest mismatch");
  const collection = JSON.parse(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }));
  if (
    collection.version !== 1 ||
    !Array.isArray(collection.cases) ||
    collection.cases.length === 0 ||
    collection.cases.length !== config.cases ||
    new Set(collection.cases.map((spec) => spec.id)).size !== config.cases
  )
    throw new Error("Reviewed dataset collection inventory mismatch");
  for (const spec of collection.cases) {
    if (
      spec.review?.providerSubmission !== true ||
      spec.review.status !== "reviewed" ||
      hash(JSON.stringify(spec.input)) !== spec.review.inputHash
    )
      throw new Error("Dataset input differs from its submission review");
  }
  if (!config.labelReview?.path || !/^[a-f0-9]{64}$/.test(config.labelReview.sha256 ?? ""))
    throw new Error("Dataset requires a pinned semantic label review");
  const reviewBytes = readFileSync(resolve(root, config.labelReview.path));
  if (hash(reviewBytes) !== config.labelReview.sha256)
    throw new Error("Dataset label review digest mismatch");
  const audit = JSON.parse(reviewBytes);
  if (
    audit.version !== 1 ||
    audit.archiveSha256 !== config.sha256 ||
    !Array.isArray(audit.cases) ||
    audit.cases.length !== collection.cases.length ||
    new Set(audit.cases.map((item) => item.caseId)).size !== audit.cases.length
  )
    throw new Error("Dataset label review inventory mismatch");
  const reviews = new Map(audit.cases.map((item) => [item.caseId, item]));
  if (collection.cases.some((spec) => !reviews.has(spec.id)))
    throw new Error("Dataset label review inventory mismatch");
  return collection.cases.map((spec) => ({
    ...spec,
    labelReview: validateLabelReview(spec, reviews.get(spec.id)),
  }));
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "fetch" && args.length === 0) {
    const config = json(new URL("./collection.json", import.meta.url));
    const output = resolve(config.path);
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    execFileSync(
      "gh",
      [
        "release",
        "download",
        config.tag,
        "--repo",
        config.repository,
        "--pattern",
        config.asset,
        "--output",
        output,
      ],
      { stdio: "inherit" },
    );
    readCollection();
  } else if (command === "pack" && args.length >= 3) {
    const [source, output, ...reviews] = args;
    const inventory = json(resolve(source, "cases.json"));
    const imported = Array.isArray(inventory) ? inventory : inventory.cases;
    const entries = reviews.flatMap((file) => json(file).entries);
    const cases = entries.map((review) => {
      const item = imported.find((item) => item.id === review.caseId);
      if (
        !item ||
        item.status !== "offline-eligible" ||
        review.providerSubmission !== true ||
        !/^[a-f\d]{64}$/.test(item.inputKey)
      )
        throw new Error("Unreviewed or ineligible imported case");
      const bytes = readFileSync(resolve(source, "inputs", `${item.inputKey}.json`));
      if (hash(bytes) !== item.inputKey) throw new Error("Imported input digest mismatch");
      const input = { instruction: item.instruction, ...JSON.parse(bytes) };
      if (hash(JSON.stringify(input)) !== review.inputHash)
        throw new Error("Reviewed input hash mismatch");
      return { ...makeCase(item), input, review: { ...review, status: "reviewed" } };
    });
    if (new Set(cases.map((spec) => spec.id)).size !== cases.length)
      throw new Error("Duplicate reviewed case");
    const bytes = gzipSync(JSON.stringify({ version: 1, cases }));
    mkdirSync(dirname(resolve(output)), { recursive: true, mode: 0o700 });
    writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ sha256: hash(bytes), cases: cases.length, bytes: bytes.length }));
  } else throw new Error("Use collection.mjs fetch | pack IMPORT_DIRECTORY OUTPUT REVIEW_FILE...");
}
