import assert from "node:assert/strict";
import test from "node:test";
import { adaptPhraseNode, adaptMind2Web, importDataset } from "./import.mjs";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const provenance = { dataset: "phrasenode", revision: "abc", split: "train" };
const annotation = {
  exampleId: "example-1",
  version: "v6",
  webpage: "example.test",
  phrase: "Click save",
  xid: 23,
};
const page = {
  metadata: {},
  common_styles: {},
  info: [
    { tag: "BODY", children: [1, 2] },
    { tag: "BUTTON", xid: 23, text: "Save", attributes: { "data-xid": "23" } },
    {
      tag: "INPUT",
      xid: 41,
      value: "secret",
      attributes: { placeholder: "Email", value: "secret" },
    },
  ],
};

test("PhraseNode preserves original identity outside sanitized model candidates", () => {
  const result = adaptPhraseNode(annotation, page, provenance);
  assert.equal(result.status, "offline-eligible");
  assert.equal(result.instruction, "Click save");
  assert.equal(result.oracle.sourceTargetId, "23");
  assert.equal(result.oracle.candidateId, "n2");
  assert.equal(result.candidates.find((x) => x.id === "n2").text, "Save");
  assert.doesNotMatch(JSON.stringify(result.candidates), /secret|data-xid|example-1/);
  assert.equal(result.historicalState, "unavailable");
});

test("PhraseNode prunes private and hidden subtrees before collecting ancestor text", () => {
  const source = {
    common_styles: {},
    info: [
      { tag: "BODY", children: [1, 2, 4, 6, 8, 10] },
      { tag: "BUTTON", xid: 23, text: "Save" },
      { tag: "DIV", attributes: { hidden: "" }, children: [3] },
      { tag: "SPAN", text: "HIDDEN_SECRET" },
      { tag: "IFRAME", text: "FRAME_MARKUP", children: [5] },
      { tag: "DIV", text: "FRAME_SECRET" },
      { tag: "DIV", styles: { display: "none" }, children: [7] },
      { tag: "SPAN", text: "DISPLAY_SECRET" },
      { tag: "DIV", attributes: { "aria-hidden": "true" }, children: [9] },
      { tag: "SPAN", text: "ARIA_SECRET" },
      { tag: "shadow-root", children: [11] },
      { tag: "SPAN", text: "SHADOW_SECRET" },
    ],
  };
  const result = adaptPhraseNode(annotation, source, provenance);
  assert.equal(result.status, "offline-eligible");
  assert.doesNotMatch(JSON.stringify(result.candidates), /SECRET|FRAME_MARKUP/);
  assert.deepEqual(
    result.candidates.map((item) => item.text),
    ["Save", "Save"],
  );
  const framed = structuredClone(source);
  framed.info[11].xid = 99;
  assert.deepEqual(adaptPhraseNode({ ...annotation, xid: 99 }, framed, provenance).reasons, [
    "unsupported-frame-scope",
  ]);
});

test("import verifies local bytes and writes deduplicated inputs with complete denominators", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dataset-import-"));
  try {
    const files = [];
    for (const [path, content, props] of [
      [
        "train.jsonl",
        [annotation, { ...annotation, exampleId: "example-2" }]
          .map((x) => JSON.stringify(x))
          .join("\n"),
        { kind: "commands", split: "train" },
      ],
      ["page.json", JSON.stringify(page), { kind: "page", page: "v6/example.test" }],
    ]) {
      await writeFile(join(dir, path), content);
      files.push({
        path,
        sha256: createHash("sha256").update(content).digest("hex"),
        url: "https://example.test/" + path,
        ...props,
      });
    }
    const manifest = { version: 1, dataset: "phrasenode", revision: "abc", files };
    const result = await importDataset(manifest, { sourceRoot: dir, outputRoot: join(dir, "out") });
    assert.equal(result.inventory.total, 2);
    assert.equal(result.inventory.statuses["offline-eligible"], 2);
    assert.equal(result.cases[0].inputKey, result.cases[1].inputKey);
    assert.equal(result.cases[0].candidates, undefined);
    const input = JSON.parse(
      await readFile(join(dir, "out", "inputs", result.cases[0].inputKey + ".json"), "utf8"),
    );
    assert.equal(input.candidates.length, 3);
    assert.equal(input.oracle, undefined);
    await assert.rejects(
      importDataset(
        { ...manifest, files: [{ ...files[0], sha256: "0".repeat(64) }] },
        { sourceRoot: dir, outputRoot: join(dir, "bad") },
      ),
      /checksum/,
    );
    await assert.rejects(
      importDataset(
        { ...manifest, files: [{ ...files[0], kind: "unknown" }] },
        { sourceRoot: dir, outputRoot: join(dir, "unknown") },
      ),
      /file kind/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Mind2Web requires independent reviewed instruction and joins original raw target", () => {
  const task = {
    annotation_id: "task-1",
    website: "example.test",
    domain: "shopping",
    subdomain: "retail",
    confirmed_task: "Buy a book",
    action_reprs: ["GOLD ANSWER"],
  };
  const action = {
    action_uid: "action-1",
    raw_html:
      '<html><body><button backend_node_id="7" data_pw_testid_buckeye="action-1">Save</button><textarea>secret</textarea><input value="secret"><div contenteditable="true">secret</div></body></html>',
    cleaned_html: "<html></html>",
    operation: { op: "CLICK", original_op: "CLICK" },
    pos_candidates: [],
  };
  const p = { dataset: "mind2web", revision: "abc", split: "train" };
  assert.equal(adaptMind2Web(task, action, 0, p).status, "adaptation-required");
  const review = {
    instruction: "Save the current item",
    action: "click",
    author: "first",
    reviewer: "second",
    policyVersion: "blind-v1",
    reviewed: true,
    targetHiddenDuringAuthoring: true,
  };
  const result = adaptMind2Web(task, action, 0, p, review);
  assert.equal(result.status, "offline-eligible");
  assert.equal(result.oracle.sourceTargetId, "7");
  assert.equal(result.candidates.find((x) => x.id === result.oracle.candidateId).text, "Save");
  assert.equal(result.source.rawOnlyTarget, true);
  assert.doesNotMatch(JSON.stringify(result.candidates), /secret|GOLD|buckeye|backend_node/);
  assert.equal(result.action, "click");
});

test("PhraseNode does not turn missing, duplicate, hidden, cyclic or absent page targets into success", () => {
  assert.deepEqual(adaptPhraseNode({ ...annotation, xid: 999 }, page, provenance).reasons, [
    "missing-target-id",
  ]);
  assert.deepEqual(
    adaptPhraseNode(
      annotation,
      { ...page, info: [...page.info, { tag: "BUTTON", xid: 23 }] },
      provenance,
    ).reasons,
    ["duplicate-target-id"],
  );
  assert.deepEqual(adaptPhraseNode(annotation, undefined, provenance).reasons, ["missing-page"]);
  const hidden = structuredClone(page);
  hidden.info[0].attributes = { "aria-hidden": "true" };
  assert.deepEqual(adaptPhraseNode(annotation, hidden, provenance).reasons, [
    "accessibility-hidden-target",
  ]);
  const cyclic = structuredClone(page);
  cyclic.info[1].children = [0];
  assert.deepEqual(adaptPhraseNode(annotation, cyclic, provenance).reasons, ["invalid-page-tree"]);
  assert.deepEqual(adaptPhraseNode(null, page, provenance).reasons, ["invalid-annotation"]);
  assert.deepEqual(adaptPhraseNode(annotation, { info: [null] }, provenance).reasons, [
    "invalid-page",
  ]);
  assert.deepEqual(adaptPhraseNode({ ...annotation, equiv: [23, 41] }, page, provenance).reasons, [
    "source-equivalence-review-required",
  ]);
  const cssHidden = structuredClone(page);
  cssHidden.info[0].styles = { display: "none" };
  assert.deepEqual(adaptPhraseNode(annotation, cssHidden, provenance).reasons, [
    "accessibility-hidden-target",
  ]);
  const offscreen = structuredClone(page);
  offscreen.info[1].hidden = true;
  offscreen.info[1].width = 0;
  assert.equal(adaptPhraseNode(annotation, offscreen, provenance).status, "offline-eligible");
});

test("Mind2Web rejects conflicting source or instruction identities and preserves original operations", () => {
  const task = { annotation_id: "task", action_reprs: ["Click GOLD"] };
  const action = {
    action_uid: "a",
    raw_html: '<button backend_node_id="7" data_pw_testid_buckeye="a">Save</button>',
    operation: { op: "CLICK", original_op: "HOVER" },
    pos_candidates: [],
  };
  const p = { dataset: "mind2web", revision: "abc", split: "train" };
  const review = {
    instruction: "Hover over save",
    action: "hover",
    author: "first",
    reviewer: "second",
    policyVersion: "blind-v1",
    reviewed: true,
    targetHiddenDuringAuthoring: true,
  };
  assert.equal(adaptMind2Web(task, action, 0, p, review).action, "hover");
  assert.deepEqual(
    adaptMind2Web(
      task,
      { ...action, pos_candidates: [{ is_original_target: true, backend_node_id: "8" }] },
      0,
      p,
      review,
    ).reasons,
    ["conflicting-original-target"],
  );
  assert.deepEqual(
    adaptMind2Web(task, action, 0, p, { ...review, instruction: "Click GOLD" }).reasons,
    ["gold-action-as-instruction"],
  );
  assert.deepEqual(adaptMind2Web(task, action, 0, p, { ...review, reviewer: "first" }).reasons, [
    "independent-instruction-required",
  ]);
  assert.deepEqual(adaptMind2Web(task, action, 0, p, { ...review, action: "click" }).reasons, [
    "adaptation-action-conflict",
  ]);
  assert.deepEqual(
    adaptMind2Web(task, { ...action, raw_html: action.raw_html + action.raw_html }, 0, p, review)
      .reasons,
    ["duplicate-target-id"],
  );
});

test("Mind2Web removes frame and hidden subtree text from every candidate", () => {
  const task = { annotation_id: "task" };
  const action = {
    action_uid: "a",
    raw_html: `<main><button backend_node_id="7" data_pw_testid_buckeye="a">Save</button>
      <iframe><input value="FRAME_SECRET">FRAME_MARKUP</iframe>
      <shadow-root><span>SHADOW_SECRET</span></shadow-root>
      <div hidden>HIDDEN_SECRET</div><div aria-hidden="true">ARIA_SECRET</div>
      <div style="display: none"><span>DISPLAY_SECRET</span></div>
      <div style="content-visibility: hidden">CONTENT_SECRET</div></main>`,
    operation: { op: "CLICK" },
    pos_candidates: [],
  };
  const p = { dataset: "mind2web", revision: "abc", split: "train" };
  const result = adaptMind2Web(task, action, 0, p);
  assert.equal(result.status, "adaptation-required");
  assert.doesNotMatch(JSON.stringify(result.candidates), /SECRET|FRAME_MARKUP|<input/);
  assert.equal(result.candidates.find((x) => x.id === result.oracle.candidateId).text, "Save");
  assert.deepEqual(
    adaptMind2Web(
      task,
      { ...action, raw_html: `<div style="display:none">${action.raw_html}</div>` },
      0,
      p,
    ).reasons,
    ["sanitization-removed-target"],
  );
  assert.deepEqual(
    adaptMind2Web(
      task,
      { ...action, raw_html: `<shadow-root>${action.raw_html}</shadow-root>` },
      0,
      p,
    ).reasons,
    ["unsupported-frame-scope"],
  );
});

test("Mind2Web respects inherited inline visibility and explicit visible descendants", () => {
  const task = { annotation_id: "task" };
  const action = {
    action_uid: "a",
    raw_html: '<button backend_node_id="7" data_pw_testid_buckeye="a">Save</button>',
    operation: { op: "CLICK" },
    pos_candidates: [],
  };
  const p = { dataset: "mind2web", revision: "abc", split: "train" };
  for (const visibility of ["hidden", "collapse"]) {
    const concealed = `<main style="visibility:${visibility}">PRIVATE_TEXT${action.raw_html}</main>`;
    assert.deepEqual(adaptMind2Web(task, { ...action, raw_html: concealed }, 0, p).reasons, [
      "accessibility-hidden-target",
    ]);
    const visible = concealed.replace("<button", '<button style="visibility:visible"');
    const result = adaptMind2Web(task, { ...action, raw_html: visible }, 0, p);
    assert.equal(result.status, "adaptation-required");
    assert.doesNotMatch(JSON.stringify(result.candidates), /PRIVATE_TEXT/);
    assert.equal(
      result.candidates.find((item) => item.id === result.oracle.candidateId).text,
      "Save",
    );
  }
});

test("import accounts for malformed records and excludes page families shared between splits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dataset-splits-"));
  try {
    const files = [];
    for (const [split, content] of [
      ["train", JSON.stringify(annotation) + "\nnot json"],
      ["test", JSON.stringify({ ...annotation, exampleId: "heldout" })],
    ]) {
      const path = `${split}.jsonl`;
      await writeFile(join(dir, path), content);
      files.push({
        path,
        sha256: createHash("sha256").update(content).digest("hex"),
        url: `https://example.test/${path}`,
        kind: "commands",
        split,
      });
    }
    const result = await importDataset(
      { version: 1, dataset: "phrasenode", revision: "abc", files },
      { sourceRoot: dir, outputRoot: join(dir, "out") },
    );
    assert.equal(result.inventory.total, 3);
    assert.equal(result.inventory.reasons["family-split-leakage"], 2);
    assert.equal(result.inventory.reasons["invalid-json-record"], 1);
    assert.equal(result.inventory.statuses["offline-eligible"], undefined);
    assert.equal(result.inventory.splits.train.total, 2);
    assert.equal(result.inventory.splits.test.total, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Mind2Web import streams tasks across chunk boundaries without splitting quoted JSON punctuation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dataset-stream-"));
  try {
    const tasks = [1, 2].map((n) => ({
      annotation_id: `task-${n}`,
      confirmed_task: 'quoted \\" }, [ 🌍 '.repeat(7000),
      actions: [
        {
          action_uid: `a-${n}`,
          raw_html: `<button backend_node_id="7" data_pw_testid_buckeye="a-${n}">Save</button>`,
          operation: { op: "CLICK" },
          pos_candidates: [],
        },
      ],
    }));
    const content = JSON.stringify(tasks);
    await writeFile(join(dir, "tasks.json"), content);
    const result = await importDataset(
      {
        version: 1,
        dataset: "mind2web",
        revision: "abc",
        files: [
          {
            path: "tasks.json",
            kind: "tasks",
            split: "train",
            url: "https://example.test/tasks.json",
            sha256: createHash("sha256").update(content).digest("hex"),
          },
        ],
      },
      { sourceRoot: dir, outputRoot: join(dir, "out") },
    );
    assert.equal(result.inventory.total, 2);
    assert.equal(result.inventory.statuses["adaptation-required"], 2);
    assert.equal(result.cases[1].source.annotationId, "task-2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("oversized Mind2Web task remains an explicit uncounted-action inventory limitation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dataset-bound-"));
  try {
    const content = JSON.stringify([
      { annotation_id: "big", unknown: "x".repeat(2000), actions: [] },
      { annotation_id: "small", actions: [] },
    ]);
    await writeFile(join(dir, "tasks.json"), content);
    const result = await importDataset(
      {
        version: 1,
        dataset: "mind2web",
        revision: "abc",
        files: [
          {
            path: "tasks.json",
            kind: "tasks",
            split: "train",
            url: "https://example.test/tasks.json",
            sha256: createHash("sha256").update(content).digest("hex"),
          },
        ],
      },
      { sourceRoot: dir, outputRoot: join(dir, "out"), maxTaskCharacters: 1000 },
    );
    assert.equal(result.inventory.reasons["task-size-limit"], 1);
    assert.equal(result.inventory.uncountedActionTasks, 1);
    assert.equal(result.inventory.total, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Mind2Web excludes overlap in supplied cross-website and cross-domain partitions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dataset-domains-"));
  try {
    const files = [];
    for (const [split, website, domain] of [
      ["train", "shop", "shopping"],
      ["test_website", "shop", "shopping"],
      ["test_domain", "other-shop", "shopping"],
    ]) {
      const task = {
        annotation_id: split,
        website,
        domain,
        actions: [
          {
            action_uid: split,
            raw_html: `<button backend_node_id="7" data_pw_testid_buckeye="${split}">Save</button>`,
            operation: { op: "CLICK" },
          },
        ],
      };
      const content = JSON.stringify([task]);
      const path = `${split}.json`;
      await writeFile(join(dir, path), content);
      files.push({
        path,
        url: `https://example.test/${path}`,
        sha256: createHash("sha256").update(content).digest("hex"),
        kind: "tasks",
        split,
      });
    }
    const result = await importDataset(
      { version: 1, dataset: "mind2web", revision: "abc", files },
      { sourceRoot: dir, outputRoot: join(dir, "out") },
    );
    assert.deepEqual(result.cases.find((x) => x.split === "test_website").reasons, [
      "independent-instruction-required",
      "website-split-leakage",
    ]);
    assert.deepEqual(result.cases.find((x) => x.split === "test_domain").reasons, [
      "independent-instruction-required",
      "domain-split-leakage",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
