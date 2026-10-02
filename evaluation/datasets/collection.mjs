import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { makeCase } from "./run.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
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
  return collection.cases;
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
