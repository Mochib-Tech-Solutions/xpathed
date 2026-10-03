import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { unpackImages, validateReceipt, deploymentFiles } from "./download.mjs";

test("release image parts reassemble in numeric order and reject gaps or corruption", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "release-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const compressed = gzipSync(Buffer.from("Browser and Resolver image bytes"));
  for (const variant of ["complete", "missing", "corrupt"]) {
    const directory = join(root, variant),
      bundle = join(directory, "bundle");
    await mkdir(bundle, { recursive: true });
    const bytes = variant === "corrupt" ? Buffer.from("invalid gzip archive") : compressed;
    await writeFile(
      join(directory, "browser-resolver-images.tar.gz.part-0001"),
      bytes.subarray(10),
    );
    if (variant !== "missing")
      await writeFile(
        join(directory, "browser-resolver-images.tar.gz.part-0000"),
        bytes.subarray(0, 10),
      );
    if (variant === "complete") {
      await unpackImages(directory, bundle);
      assert.equal(
        await readFile(join(bundle, "images.tar"), "utf8"),
        "Browser and Resolver image bytes",
      );
    } else await assert.rejects(unpackImages(directory, bundle));
  }
});

test("download receipts bind source, commit and every deployment file", () => {
  const commit = "a".repeat(40);
  const receipt = {
    commit,
    testedCommit: "b".repeat(40),
    tree: "c".repeat(40),
    bundleSha256: "d".repeat(64),
    deploymentFiles: Object.fromEntries(deploymentFiles.map((name) => [name, "e".repeat(64)])),
  };
  assert.doesNotThrow(() => validateReceipt(receipt, commit));
  for (const changed of [
    { ...receipt, commit: "f".repeat(40) },
    { ...receipt, testedCommit: "main" },
    { ...receipt, deploymentFiles: {} },
  ])
    assert.throws(() => validateReceipt(changed, commit));
});
