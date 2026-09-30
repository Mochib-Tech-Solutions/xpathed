import assert from "node:assert/strict";
import test from "node:test";
import { reconstructPhraseNode } from "./reconstruction.mjs";

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
