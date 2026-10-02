import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const phraseRevision = "84464381f5339196a1bbc937f6906bd99d5346b9";
const mindRevision = "17ece8eb89862368edc0cc806acee6fca5163474";
const assets = [
  {
    path: "phrasenode-commands.zip",
    url: "https://nlp.stanford.edu/projects/phrasenode/dataset-final.zip",
    bytes: 2552602,
    sha256: "dfa833600db6b24d36152c2ff3ccc8578d4a47e8b6cf688ba6e33d0cd45fb137",
    license: "CC-BY-4.0",
  },
  {
    path: "phrasenode-pages.zip",
    url: "https://nlp.stanford.edu/projects/phrasenode/processed-pages.zip",
    bytes: 136441380,
    sha256: "2a602d6e30b05c3b69495bdd06e5bce8cddfd824de9ed0910463c31a173c364a",
    license: "ODC-By-1.0",
  },
  {
    path: "mind2web-train10.json",
    url: `https://huggingface.co/datasets/osunlp/Mind2Web/resolve/${mindRevision}/data/train/train_10.json`,
    bytes: 28366146,
    sha256: "182542d7947b3fa9e90fc57a3d82d4d8f2997ca5a06664217720d7a78a956e33",
    license: "CC-BY-4.0",
  },
];

async function safePath(root, path) {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Invalid relative source path");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  let current = root;
  for (const part of ["", ...path.split("/").slice(0, -1)]) {
    if (part) {
      current = join(current, part);
      await mkdir(current, { recursive: true, mode: 0o700 });
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Source directory must not be a symlink");
  }
  return join(root, path);
}

async function verify(path, expected) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Source must be a regular file");
  if (info.size !== expected.bytes) throw new Error(`Source size mismatch: ${path}`);
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  if (digest.digest("hex") !== expected.sha256)
    throw new Error(`Source checksum mismatch: ${path}`);
  return true;
}

export async function publishFile(root, relativePath, bytes) {
  const path = await safePath(root, relativePath);
  const expected = { bytes: bytes.length, sha256: hash(bytes) };
  if (await verify(path, expected)) return;
  const temporary = `${path}.partial-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function acquireAsset(root, asset, fetcher = fetch) {
  if (
    !/^https:\/\//u.test(asset.url) ||
    !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 1
  ) {
    throw new Error("Invalid pinned source metadata");
  }
  const path = await safePath(root, asset.path);
  if (await verify(path, asset)) return path;
  const temporary = `${path}.partial-${randomUUID()}`;
  try {
    const response = await fetcher(asset.url, { signal: AbortSignal.timeout(300000) });
    if (!response.ok || !response.body) throw new Error(`Source HTTP failure: ${response.status}`);
    const digest = createHash("sha256");
    let count = 0;
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(bytes, _encoding, done) {
          count += bytes.length;
          if (count > asset.bytes) return done(new Error("Source exceeds pinned size"));
          digest.update(bytes);
          done(null, bytes);
        },
      }),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    if (count !== asset.bytes) throw new Error("Source size mismatch");
    if (digest.digest("hex") !== asset.sha256) throw new Error("Source checksum mismatch");
    await link(temporary, path);
    return path;
  } finally {
    await rm(temporary, { force: true });
  }
}

export function allowedMember(kind, name) {
  if (/[\r\n]/u.test(name)) return false;
  return kind === "commands"
    ? /^combined-v2-cleaned\.(all|train|dev|test)\.jsonl$/u.test(name)
    : kind === "pages" && (name === "v6/" || /^v6\/info-[a-zA-Z0-9._-]+\.gz$/u.test(name));
}

async function unpack(root, asset, kind) {
  const archive = join(root, asset.path);
  const { stdout } = await exec("unzip", ["-Z1", archive], { maxBuffer: 1024 * 1024 });
  const names = stdout.trim().split(/\r?\n/u);
  if (new Set(names).size !== names.length || names.some((name) => !allowedMember(kind, name))) {
    throw new Error(`Unexpected or duplicate archive member: ${asset.path}`);
  }
  const files = [];
  for (const name of names) {
    if (name.endsWith("/") || name === "combined-v2-cleaned.all.jsonl") continue;
    // Read one named member as bytes; never let unzip create paths or symlinks.
    const { stdout: bytes } = await exec("unzip", ["-p", archive, name], {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    });
    const path = `phrasenode-${kind}/${name}`;
    await publishFile(root, path, bytes);
    files.push({
      path,
      url: `${asset.url}#${name}`,
      sha256: hash(bytes),
      kind: kind === "commands" ? "commands" : "page",
      ...(kind === "commands"
        ? { split: name.split(".")[1] }
        : { page: `v6/${name.slice("v6/info-".length, -3)}` }),
    });
  }
  return files;
}

export async function prepareSources(output) {
  const root = resolve(output);
  for (const asset of assets) await acquireAsset(root, asset);
  const commands = await unpack(root, assets[0], "commands");
  if (commands.length !== 3) throw new Error("Missing PhraseNode original split files");
  const pages = await unpack(root, assets[1], "pages");
  const manifests = {
    "phrasenode-sources.json": {
      version: 1,
      dataset: "phrasenode",
      revision: phraseRevision,
      scope:
        "All original train/dev/test commands and processed pages; combined all file deliberately excluded.",
      attribution: {
        name: "PhraseNode",
        url: "https://nlp.stanford.edu/projects/phrasenode/",
        commands: "CC-BY-4.0",
        pages: "ODC-By-1.0",
        code: "Apache-2.0",
        rawPageAssets: "not downloaded; separate rights unverified",
      },
      archives: assets.slice(0, 2),
      files: [...commands, ...pages],
    },
    "mind2web-sources.json": {
      version: 1,
      dataset: "mind2web",
      revision: mindRevision,
      scope:
        "Training shard train_10 only: 9 tasks, 49 actions. Identity/adaptation pilot, not the full dataset or held-out evidence.",
      attribution: {
        name: "Mind2Web",
        url: "https://github.com/OSU-NLP-Group/Mind2Web",
        dataset: "CC-BY-4.0",
        code: "MIT",
        rawPageAssets: "not downloaded; separate rights unverified",
      },
      files: [{ ...assets[2], kind: "tasks", split: "train" }],
    },
  };
  for (const [name, manifest] of Object.entries(manifests)) {
    await publishFile(root, name, Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  }
  return {
    directory: root,
    manifests: Object.keys(manifests),
    commandSplits: commands.length,
    processedPages: pages.length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: { output: { type: "string", default: ".artifacts/datasets/sources" } },
    });
    console.log(JSON.stringify(await prepareSources(values.output), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
