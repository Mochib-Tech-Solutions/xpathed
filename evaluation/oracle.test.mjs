import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { JSDOM } = createRequire(new URL("../src/Web/package.json", import.meta.url))("jsdom");
const source = readFileSync(new URL("./oracle.js", import.meta.url), "utf8");

async function observe(html, command, mutate, setup) {
  const dom = new JSDOM(html, {
    url: "http://fixture/page?trial=private-trial",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const win = dom.window;
  setup?.(win.document);
  const commands = [
    { kind: "baseline", id: "baseline" },
    { kind: "observe", id: "result", ...command },
  ];
  const observations = [];
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  win.fetch = async (url, options) => {
    if (url.startsWith("/command")) return { json: async () => commands.shift() };
    observations.push(JSON.parse(options.body));
    if (observations.length === 1) mutate?.(win.document);
    if (observations.length === 2) finish();
    return {};
  };
  const timeout = setTimeout(() => finish(), 2000);
  try {
    win.eval(source);
    await done;
    return observations;
  } finally {
    clearTimeout(timeout);
    win.close();
  }
}
const action = (xpath) => ({ target: { xpaths: [xpath] } });

test("oracle reports target-set identities independently while preserving positional intended", async () => {
  const [baseline, result] = await observe(
    '<button id="a">A</button><button id="b">B</button><button id="wrong">Wrong</button>',
    {
      expected: [{ selector: "#a" }, { selector: "#b" }],
      actions: [
        action('//*[@id="b"]'),
        action('//*[@id="a"]'),
        action('//*[@id="wrong"]'),
        action('//*[@id="wrong"]'),
      ],
    },
  );
  assert.equal(result.error, undefined);
  assert.deepEqual(result.actions[0].matches[0].expectedIndices, [1]);
  assert.equal(result.actions[0].matches[0].intended, false);
  assert.equal(result.actions[0].matches[0].eligible, true);
  assert.equal(result.actions[2].matches[0].nodeId, result.actions[3].matches[0].nodeId);
  assert.notEqual(result.actions[0].matches[0].nodeId, result.actions[2].matches[0].nodeId);
  assert.equal(typeof baseline.language, "string");
  assert.ok(Array.isArray(baseline.languages));
  assert.equal(typeof baseline.timeZone, "string");
  assert.equal(baseline.initialState.length, 1);
  assert.match(baseline.documentChecksum[0], /^fnv1a32-utf16:[a-f0-9]{8}$/u);
  assert.equal(result.passiveStateUnchanged, true);
});

test("oracle excludes hidden nodes but keeps disabled and offscreen nodes, detecting field edits", async () => {
  const [, result] = await observe(
    '<div aria-hidden="true"><button id="hidden">Hidden</button></div><button id="disabled" disabled>Disabled</button><button id="offscreen" style="position:absolute;top:5000px">Far</button><input value="secret">',
    {
      expected: [null, { selector: "#disabled" }, { selector: "#offscreen" }],
      actions: [
        action('//*[@id="hidden"]'),
        action('//*[@id="disabled"]'),
        action('//*[@id="offscreen"]'),
      ],
    },
    (doc) => {
      doc.querySelector("input").value = "changed";
    },
  );
  assert.equal(result.actions[0].matches[0].eligible, false);
  assert.equal(result.actions[1].matches[0].eligible, true);
  assert.equal(result.actions[2].matches[0].eligible, true);
  assert.equal(result.passiveStateUnchanged, false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("baseline parity detects form property changes without retaining plaintext values", async () => {
  const html =
    '<input id="text" value="PRIVATE_ORIGINAL"><textarea id="area">PRIVATE_AREA</textarea><input id="check" type="checkbox"><select id="select"><option>A</option><option>B</option></select><select id="multi" multiple><option selected>A</option><option>B</option></select><div id="edit" contenteditable>PRIVATE_EDIT</div>';
  const [original] = await observe(html, { expected: [], actions: [] });
  for (const [id, change] of [
    [
      "text",
      (node) => {
        node.value = "PRIVATE_CHANGED";
      },
    ],
    [
      "area",
      (node) => {
        node.value = "PRIVATE_CHANGED";
      },
    ],
    [
      "check",
      (node) => {
        node.checked = true;
      },
    ],
    [
      "select",
      (node) => {
        node.selectedIndex = 1;
      },
    ],
    [
      "multi",
      (node) => {
        node.options[1].selected = true;
      },
    ],
    [
      "edit",
      (node) => {
        node.textContent = "PRIVATE_CHANGED";
      },
    ],
  ]) {
    const [changed] = await observe(html, { expected: [], actions: [] }, undefined, (doc) =>
      change(doc.getElementById(id)),
    );
    assert.deepEqual(changed.documentChecksum, original.documentChecksum);
    assert.notDeepEqual(changed.initialState, original.initialState, id);
    assert.equal(JSON.stringify(changed).includes("PRIVATE_"), false);
    const field = changed.initialState[0].fields.find((item) => item.id === id);
    assert.match(field.fieldStateChecksum, /^fnv1a32-utf16:[a-f0-9]{8}$/u);
    if (id === "check") assert.equal(field.checked, true);
    if (id === "select") assert.equal(field.selectedIndex, 1);
  }
  assert.equal(JSON.stringify(original).includes("PRIVATE_"), false);
});

test("passivity detects secondary multi-select changes when value and first index stay unchanged", async () => {
  const [, result] = await observe(
    "<select multiple><option selected>A</option><option>B</option></select>",
    { expected: [], actions: [] },
    (doc) => {
      const select = doc.querySelector("select");
      select.options[1].selected = true;
      assert.equal(select.value, "A");
      assert.equal(select.selectedIndex, 0);
    },
  );
  assert.equal(result.passiveStateUnchanged, false);
});
