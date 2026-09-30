import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAsset, publishFile, allowedMember } from "./dataset-sources.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const asset = (bytes) => ({
  path: "sample.json",
  url: "https://example.test/sample.json",
  bytes: bytes.length,
  sha256: hash(bytes),
});

async function temporary(run) {
  const root = await mkdtemp(join(tmpdir(), "dataset-sources-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("download verifies bytes then reuses an existing file without network", () =>
  temporary(async (root) => {
    const bytes = Buffer.from("source content");
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return new Response(bytes);
    };
    await acquireAsset(root, asset(bytes), fetcher);
    assert.deepEqual(await readFile(join(root, "sample.json")), bytes);
    await acquireAsset(root, asset(bytes), fetcher);
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(root), ["sample.json"]);
  }));

test("checksum, size and transport failures publish no source", () =>
  temporary(async (root) => {
    const bytes = Buffer.from("correct");
    for (const response of [
      new Response("changed"),
      new Response("too large"),
      new Response("short"),
      new Response("unavailable", { status: 503 }),
    ]) {
      await assert.rejects(acquireAsset(root, asset(bytes), async () => response));
      assert.deepEqual(await readdir(root), []);
    }
  }));

test("existing corrupt source is rejected and never replaced", () =>
  temporary(async (root) => {
    await writeFile(join(root, "sample.json"), "corrupt");
    let calls = 0;
    await assert.rejects(
      acquireAsset(root, asset(Buffer.from("correct")), async () => {
        calls++;
        return new Response("correct");
      }),
      /checksum/,
    );
    assert.equal(calls, 0);
    assert.equal(await readFile(join(root, "sample.json"), "utf8"), "corrupt");
  }));

test("publication is idempotent and rejects traversal and symlinks", () =>
  temporary(async (root) => {
    const bytes = Buffer.from("derived");
    await publishFile(root, "pages/sample.json", bytes);
    await publishFile(root, "pages/sample.json", bytes);
    await assert.rejects(
      publishFile(root, "pages/sample.json", Buffer.from("different")),
      /checksum|size/,
    );
    for (const path of ["../outside", "/absolute", "pages/../escape", "pages\\escape"]) {
      await assert.rejects(publishFile(root, path, bytes), /path/);
    }
    await symlink(join(root, "pages"), join(root, "linked"));
    await assert.rejects(publishFile(root, "linked/sample.json", bytes), /symlink/);
    await symlink(join(root, "pages/sample.json"), join(root, "link.json"));
    await assert.rejects(publishFile(root, "link.json", bytes), /regular file/);
  }));

test("ZIP member policy admits only known command and processed-page shapes", () => {
  assert.equal(allowedMember("commands", "combined-v2-cleaned.train.jsonl"), true);
  assert.equal(allowedMember("commands", "combined-v2-cleaned.all.jsonl"), true);
  assert.equal(allowedMember("pages", "v6/info-example.test.gz"), true);
  assert.equal(allowedMember("pages", "v6/"), true);
  for (const path of [
    "../file",
    "v6/../../file",
    "v6/info-*.gz",
    "v6/info-x.gz/child",
    "/v6/info-x.gz",
    "v6/info-x.gz\nother",
    "v6/info-x.gz\n",
  ]) {
    assert.equal(allowedMember("pages", path), false);
  }
});
