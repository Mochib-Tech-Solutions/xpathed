import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hash } from "./download.mjs";
import { verifyMerge, publishAssets } from "./publish.mjs";

test("publication accepts the tested tree across differing synthetic and final merge commits", () => {
  const receipt = {
    pr: 7,
    headSha: "a".repeat(40),
    sourceSha: "b".repeat(40),
    sourceTree: "c".repeat(40),
  };
  const pr = {
    number: 7,
    merged: true,
    merge_commit_sha: "d".repeat(40),
    head: { sha: receipt.headSha },
  };
  assert.doesNotThrow(() => verifyMerge(pr, receipt, receipt.sourceTree));
  for (const changed of [
    { ...pr, merged: false },
    { ...pr, number: 8 },
    { ...pr, head: { sha: "e".repeat(40) } },
  ])
    assert.throws(() => verifyMerge(changed, receipt, receipt.sourceTree), /differs/);
  assert.throws(() => verifyMerge(pr, receipt, "f".repeat(40)), /differs/);
  assert.throws(() => verifyMerge(pr, { ...receipt, sourceTree: undefined }, undefined), /differs/);
});

test("publication resumes a draft and publishes only after every uploaded digest matches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "release-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "release.json"),
    bytes = "tested release bytes";
  await writeFile(file, bytes);
  const options = {
    repository: "owner/repo",
    tag: "v1.0.0",
    commit: "a".repeat(40),
    testedCommit: "b".repeat(40),
    notes: "notes.md",
    files: [file],
  };
  for (const state of ["new", "draft", "published", "corrupt", "other-commit"]) {
    const calls = [];
    const gh = (...args) => {
      calls.push(args);
      if (args.includes("--slurp"))
        return JSON.stringify(
          state === "new"
            ? [[]]
            : [
                [
                  {
                    tag_name: options.tag,
                    target_commitish: state === "other-commit" ? "c".repeat(40) : options.commit,
                    draft: state !== "published",
                  },
                ],
              ],
        );
      if (args[0] === "api" && args[1].includes("/releases/tags/"))
        return JSON.stringify({
          draft: state !== "published",
          assets: [
            {
              name: "release.json",
              digest: state === "corrupt" ? "sha256:wrong" : `sha256:${hash(bytes)}`,
            },
          ],
        });
      if (args[0] === "api" && args[1].includes("matching-refs"))
        return JSON.stringify([{ object: { sha: options.testedCommit } }]);
      return "";
    };
    if (["corrupt", "other-commit"].includes(state)) {
      await assert.rejects(publishAssets(options, gh));
      assert.ok(!calls.some((args) => args.includes("--draft=false")));
    } else {
      await publishAssets(options, gh);
      assert.equal(
        calls.some((args) => args.includes("--draft=false")),
        state !== "published",
      );
      assert.equal(
        calls.some((args) => args[1] === "upload"),
        state !== "published",
      );
      assert.equal(
        calls.some((args) => args[1] === "create"),
        state === "new",
      );
    }
  }
});
