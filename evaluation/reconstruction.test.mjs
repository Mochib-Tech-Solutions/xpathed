import assert from "node:assert/strict";
import test from "node:test";
import { reconstructPhraseNode } from "./reconstruction.mjs";
import { importDataset } from "./datasets.mjs";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

test("static derivative preserves independently mapped target identity without source IDs or active assets", () => {
  const page = {
    info: [
      { tag: "BODY", children: [1, 2, 3] },
      {
        tag: "A",
        xid: 23,
        text: "Home",
        attributes: { href: "https://example.test/", "data-xid": "23", onclick: "bad()" },
      },
      { tag: "INPUT", attributes: { value: "PRIVATE_VALUE" }, value: "PRIVATE_VALUE" },
      { tag: "SCRIPT", text: "bad()" },
    ],
  };
  const result = reconstructPhraseNode({ xid: 23 }, page, { revision: "source-revision" });
  assert.equal(result.mode, "derived-static-dom");
  assert.equal(result.historicalState, "unavailable");
  assert.equal(result.oracle.sourceTargetId, "23");
  assert.equal(result.oracle.selector, "html > body > div:nth-of-type(1) > a:nth-of-type(1)");
  assert.equal(result.nodeMap.find((x) => x.sourceIndex === 1).selector, result.oracle.selector);
  assert.doesNotMatch(
    JSON.stringify(result.fixture),
    /PRIVATE_VALUE|data-xid|onclick|https:|bad\(\)/,
  );
  assert.match(result.html, /href="#"/);
  assert.equal(result.omissions.removedNodes, 1);
});

test("reconstruction fails rather than guessing when sanitization removes the source target", () => {
  assert.throws(
    () =>
      reconstructPhraseNode(
        { xid: 7 },
        {
          info: [
            { tag: "BODY", children: [1] },
            { tag: "SCRIPT", xid: 7 },
          ],
        },
        {},
      ),
    /target/,
  );
  assert.throws(
    () => reconstructPhraseNode({ xid: 7 }, { info: [{ tag: "BODY", children: [0] }] }, {}),
    /tree/,
  );
});

test("reconstruction rejects duplicate source identity and parser-repaired adjacency", () => {
  assert.throws(
    () =>
      reconstructPhraseNode(
        { xid: 7 },
        {
          info: [
            { tag: "BODY", children: [1, 2] },
            { tag: "A", xid: 7, text: "First" },
            { tag: "A", xid: 7, text: "Second" },
          ],
        },
        {},
      ),
    /ambiguous/,
  );
  assert.throws(
    () =>
      reconstructPhraseNode(
        { xid: 7 },
        {
          info: [
            { tag: "TABLE", children: [1] },
            { tag: "TR", xid: 7, children: [2] },
            { tag: "TD", text: "Row" },
          ],
        },
        {},
      ),
    /changed during parsing/,
  );
});

test("editable descendants and frame fallback markup never enter the derivative", () => {
  const result = reconstructPhraseNode(
    { xid: 7 },
    {
      info: [
        { tag: "BODY", children: [1, 2, 4] },
        { tag: "BUTTON", xid: 7, text: "Save" },
        {
          tag: "DIV",
          attributes: { contenteditable: "true" },
          children: [3],
          text: "PRIVATE_PARENT",
        },
        { tag: "SPAN", text: "PRIVATE_CHILD" },
        { tag: "IFRAME", text: "PRIVATE_FRAME", children: [5] },
        { tag: "INPUT", attributes: { value: "PRIVATE_FIELD" } },
      ],
    },
    {},
  );
  assert.doesNotMatch(result.html, /PRIVATE_|contenteditable|iframe/);
  assert.equal(result.omissions.clearedValues, 1);
  assert.equal(result.omissions.removedNodes, 1);
  assert.equal(result.nodeMap.length, 3);
});

test("reconstruction CLI verifies pinned files and writes a reproducible private new suite", async () => {
  const root = await mkdtemp(join(tmpdir(), "reconstruction-cli-"));
  try {
    const commands =
      JSON.stringify({
        exampleId: "source-case",
        version: "v6",
        webpage: "example.test",
        xid: 7,
        phrase: "go to home page",
      }) + "\n";
    const page = gzipSync(
      JSON.stringify({
        info: [
          { tag: "BODY", children: [1] },
          { tag: "A", xid: 7, text: "Home" },
        ],
      }),
    );
    await writeFile(join(root, "commands.jsonl"), commands);
    await writeFile(join(root, "page.gz"), page);
    const sha = (data) => createHash("sha256").update(data).digest("hex");
    const imported = join(root, "import");
    await importDataset(
      {
        version: 1,
        dataset: "phrasenode",
        revision: "fixture",
        files: [
          {
            path: "commands.jsonl",
            url: "https://example.test/commands",
            sha256: sha(commands),
            kind: "commands",
            split: "train",
          },
          {
            path: "page.gz",
            url: "https://example.test/page",
            sha256: sha(page),
            kind: "page",
            page: "v6/example.test",
          },
        ],
      },
      { sourceRoot: root, outputRoot: imported },
    );
    const [item] = JSON.parse(await readFile(join(imported, "cases.json")));
    const output = join(root, "private", "suite.json");
    const run = (target = output, sourceRoot = root) =>
      spawnSync(
        process.execPath,
        [
          "evaluation/reconstruction.mjs",
          "--import",
          imported,
          "--source-root",
          sourceRoot,
          "--case",
          item.id,
          "--output",
          target,
        ],
        { encoding: "utf8" },
      );
    assert.equal(run().status, 0);
    const suite = JSON.parse(await readFile(output));
    assert.equal(
      suite.cases[0].expected.actions[0].target.selector,
      "html > body > div:nth-of-type(1) > a:nth-of-type(1)",
    );
    assert.equal(suite.cases[0].provenance.actionLabelSource, "controlled-browser-probe");
    assert.equal(suite.cases[0].provenance.sourceActionLabel, "unavailable");
    assert.equal(suite.cases[0].split, "train");
    assert.equal(run().status, 1, "existing private suite must not be overwritten");
    const second = join(root, "second.json");
    assert.equal(run(second).status, 0);
    assert.equal(await readFile(output, "utf8"), await readFile(second, "utf8"));
    await writeFile(join(root, "page.gz"), gzipSync("{}"));
    assert.match(run(join(root, "bad.json")).stderr, /checksum mismatch/);
    await symlink(join(root, "commands.jsonl"), join(imported, "commands.jsonl"));
    assert.match(run(join(root, "outside.json"), imported).stderr, /escapes root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
