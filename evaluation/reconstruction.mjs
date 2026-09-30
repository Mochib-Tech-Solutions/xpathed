import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { derivedTags, derivedAttributes, renderDerivedBody } from "./fixtures.mjs";

const { JSDOM } = createRequire(new URL("../src/Web/package.json", import.meta.url))("jsdom");
export const reconstructionVersion = "phrasenode-static-tree-v1";

export function reconstructPhraseNode(annotation, page, provenance) {
  if (!Array.isArray(page?.info) || !page.info.length) throw new Error("Invalid source tree");
  const omissions = { removedNodes: 0, renamedTags: 0, removedAttributes: 0, clearedValues: 0 };
  const sources = new Map(),
    seen = new Set();
  const build = (index, depth = 0) => {
    if (!Number.isInteger(index) || !page.info[index] || seen.has(index) || depth > 100)
      throw new Error("Invalid source tree");
    seen.add(index);
    const source = page.info[index],
      originalTag = String(source.tag).toLowerCase();
    if (
      ["script", "style", "noscript", "iframe", "frame", "object", "embed"].includes(originalTag)
    ) {
      omissions.removedNodes++;
      return null;
    }
    if (originalTag === "t")
      return { tag: "#text", text: String(source.text ?? "").slice(0, 1000) };
    const tag = derivedTags.has(originalTag) ? originalTag : "div";
    if (tag !== originalTag) omissions.renamedTags++;
    const attributes = {};
    for (const [name, value] of Object.entries(source.attributes ?? {})) {
      if (derivedAttributes.has(name) && typeof value === "string")
        attributes[name] = value.slice(0, 1000);
      else omissions.removedAttributes++;
    }
    if (tag === "a") attributes.href = "#";
    if (tag === "button") attributes.type = "button";
    const clear =
      ["input", "textarea"].includes(tag) ||
      (source.attributes?.contenteditable !== undefined &&
        source.attributes.contenteditable !== "false");
    if (clear) omissions.clearedValues++;
    const node = {
      tag,
      attributes,
      text: clear ? "" : String(source.text ?? "").slice(0, 1000),
      children: [],
    };
    sources.set(node, {
      sourceIndex: index,
      sourceXid: source.xid ?? null,
      sourceTag: originalTag,
    });
    if (!clear && !["input", "img", "br", "hr"].includes(tag))
      for (const child of source.children ?? []) {
        const result = build(child, depth + 1);
        if (result) node.children.push(result);
      }
    return node;
  };
  const tree = build(0);
  const fixture = { kind: "derived-static-dom", tree };
  const body = renderDerivedBody(fixture);
  fixture.sha256 = createHash("sha256").update(JSON.stringify(tree)).digest("hex");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Derived static DOM</title></head><body>${body}</body></html>`;
  const window = new JSDOM(html).window;
  const nodeMap = [];
  try {
    const check = (expected, actual, selector) => {
      if (expected.tag === "#text") {
        if (actual?.nodeType !== 3 || actual.textContent !== expected.text)
          throw new Error("Reconstructed tree text changed during parsing");
        return;
      }
      if (actual?.localName !== expected.tag)
        throw new Error("Reconstructed tree changed during parsing");
      if (window.document.querySelectorAll(selector).length !== 1)
        throw new Error("Ambiguous reconstructed source mapping");
      for (const [name, value] of Object.entries(expected.attributes))
        if (actual.getAttribute(name) !== value)
          throw new Error("Reconstructed attributes changed during parsing");
      nodeMap.push({ ...sources.get(expected), selector, tag: actual.localName });
      let offset = expected.text ? 1 : 0;
      if (offset && actual.firstChild?.textContent !== expected.text)
        throw new Error("Reconstructed text changed during parsing");
      if (actual.childNodes.length !== expected.children.length + offset)
        throw new Error("Reconstructed tree children changed during parsing");
      const positions = {};
      for (const child of expected.children) {
        const position = (positions[child.tag] = (positions[child.tag] ?? 0) + 1);
        check(
          child,
          actual.childNodes[offset++],
          `${selector} > ${child.tag}:nth-of-type(${position})`,
        );
      }
    };
    check(tree, window.document.body.firstElementChild, `html > body > ${tree.tag}:nth-of-type(1)`);
    const targets = nodeMap.filter((node) => node.sourceXid === annotation.xid);
    if (targets.length !== 1)
      throw new Error("Source target is missing or ambiguous after reconstruction");
    return {
      version: reconstructionVersion,
      mode: "derived-static-dom",
      historicalState: "unavailable",
      limitations: [
        "Styles, scripts, network assets and form values removed",
        "Document wrappers may be renamed",
        "Anchors point to an inert local fragment",
        "Only identity in this derivative DOM can be validated",
      ],
      provenance,
      fixture,
      html,
      nodeMap,
      oracle: { sourceTargetId: String(annotation.xid), selector: targets[0].selector },
      omissions,
    };
  } finally {
    window.close();
  }
}
