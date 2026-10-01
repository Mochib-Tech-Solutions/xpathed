import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, realpath, lstat } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
const safe = (path) =>
  typeof path === "string" &&
  /^\.artifacts\/[a-zA-Z0-9_./-]+$/.test(path) &&
  !path.split("/").some((part) => ["", ".", ".."].includes(part));
async function regular(path) {
  ensure(
    (await lstat(path)).isFile() && (await realpath(path)) === resolve(path),
    "Archive input must be a regular file without symlinks",
  );
  return readFile(path);
}

async function main() {
  process.umask(0o077);
  const [command, file, flag, digest, output] = process.argv.slice(2);
  ensure(
    flag === "--sha256" && /^[a-f\d]{64}$/.test(digest ?? ""),
    "A caller-pinned SHA-256 is required",
  );
  const bytes = await regular(file);
  ensure(hash(bytes) === digest, "Archive or candidate digest mismatch");
  if (command === "pack") {
    ensure(output && process.argv.length === 7, "Use pack CANDIDATE --sha256 DIGEST OUTPUT");
    execFileSync(process.execPath, ["scripts/release.mjs", "verify", file, "--sha256", digest], {
      stdio: "inherit",
    });
    const candidate = JSON.parse(bytes);
    ensure(
      candidate.version === 2 && candidate.status === "artifact-bound-evidence-verified",
      "Archive requires portable artifact-bound evidence",
    );
    const candidateFile = relative(process.cwd(), resolve(file));
    const files = {};
    for (const [path, expected] of Object.entries({
      ...candidate.files,
      [candidateFile]: digest,
    })) {
      ensure(safe(path), "Unsafe archive path");
      const content = await regular(path);
      ensure(hash(content) === expected, "Evidence changed while archiving");
      files[path] = { sha256: expected, bytes: content.length, data: content.toString("base64") };
    }
    const archive = gzipSync(
      JSON.stringify({
        version: 1,
        sourceSha: candidate.sourceSha,
        candidateFile,
        candidateSha256: digest,
        files,
      }),
    );
    await writeFile(output, archive, { flag: "wx", mode: 0o600 });
    console.log(
      `Private evidence archive SHA-256: ${hash(archive)}. Original evidence expiry remains unchanged.`,
    );
    return;
  }
  ensure(
    command === "restore" && !output && process.argv.length === 6,
    "Use restore ARCHIVE --sha256 DIGEST",
  );
  const archive = JSON.parse(gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 }));
  ensure(
    archive.version === 1 &&
      safe(archive.candidateFile) &&
      /^[a-f\d]{40}$/.test(archive.sourceSha ?? ""),
    "Invalid evidence archive",
  );
  ensure(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() === archive.sourceSha,
    "Restore requires the recorded source checkout",
  );
  const entries = Object.entries(archive.files ?? {});
  ensure(entries.length > 0 && entries.length <= 10000, "Invalid archive inventory");
  const decoded = entries.map(([path, entry]) => {
    ensure(
      safe(path) && /^[a-f\d]{64}$/.test(entry.sha256 ?? "") && typeof entry.data === "string",
      "Unsafe archive entry",
    );
    const content = Buffer.from(entry.data, "base64");
    ensure(
      content.length === entry.bytes && hash(content) === entry.sha256,
      "Archive entry mismatch",
    );
    return [path, content];
  });
  ensure(
    archive.files[archive.candidateFile]?.sha256 === archive.candidateSha256,
    "Candidate is absent or altered",
  );
  const candidate = JSON.parse(decoded.find(([path]) => path === archive.candidateFile)[1]);
  const expected = { ...candidate.files, [archive.candidateFile]: archive.candidateSha256 };
  ensure(
    candidate.version === 2 &&
      candidate.sourceSha === archive.sourceSha &&
      Object.keys(expected).length === entries.length &&
      entries.every(([path, entry]) => expected[path] === entry.sha256),
    "Evidence inventory differs from candidate",
  );
  for (const [path, content] of decoded) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    ensure(
      (await realpath(dirname(path))) === resolve(dirname(path)),
      "Archive destination cannot contain symlinks",
    );
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  }
  execFileSync(
    process.execPath,
    ["scripts/release.mjs", "verify", archive.candidateFile, "--sha256", archive.candidateSha256],
    { stdio: "inherit" },
  );
  console.log("Private evidence restored and verified; runtime default unchanged.");
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
