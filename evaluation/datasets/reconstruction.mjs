import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { derivedTags, derivedAttributes, renderDerivedBody } from "../fixtures/pages.mjs";

const { JSDOM } = createRequire(new URL("../../src/Web/package.json", import.meta.url))("jsdom");
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

export async function createBrowserSuite(values) {
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const imported = resolve(values.import);
  const root = await realpath(values["source-root"]);
  const manifest = JSON.parse(await readFile(join(imported, "manifest.json"), "utf8"));
  const bytes = await readFile(join(imported, "cases.json"));
  if (manifest.dataset !== "phrasenode" || hash(bytes) !== manifest.casesSha256)
    throw new Error("PhraseNode import integrity mismatch");
  const matches = JSON.parse(bytes).filter((item) => item.id === values.case);
  if (matches.length !== 1 || matches[0].status !== "offline-eligible")
    throw new Error("Select exactly one eligible PhraseNode case");
  const item = matches[0];
  async function source(path, sha256, kind) {
    const entry = manifest.files.find((file) => file.path === path && file.kind === kind);
    if (!entry || entry.sha256 !== sha256) throw new Error("Source provenance mismatch");
    const filename = await realpath(resolve(root, path));
    const local = relative(root, filename);
    if (!local || local.startsWith("..") || isAbsolute(local))
      throw new Error("Source escapes root");
    const data = await readFile(filename);
    if (hash(data) !== sha256) throw new Error("Source checksum mismatch");
    return data;
  }
  const commands = await source(
    item.provenance.sourcePath,
    item.provenance.sourceSha256,
    "commands",
  );
  const annotation = JSON.parse(
    commands.toString("utf8").split(/\r?\n/)[item.provenance.sourceLine - 1],
  );
  if (
    annotation.exampleId !== item.provenance.originalId ||
    annotation.phrase !== item.instruction ||
    annotation.xid !== item.source.xid ||
    annotation.version !== item.source.version ||
    annotation.webpage !== item.source.webpage
  )
    throw new Error("Imported annotation differs from pinned source");
  const pageBytes = await source(item.provenance.page.path, item.provenance.page.sha256, "page");
  const page = JSON.parse(gunzipSync(pageBytes, { maxOutputLength: 64 * 1024 * 1024 }));
  const reconstruction = reconstructPhraseNode(annotation, page, item.provenance);
  if (!/^[a-f0-9]{64}$/.test(item.inputKey)) throw new Error("Invalid input identity");
  const input = await readFile(join(imported, "inputs", `${item.inputKey}.json`));
  if (hash(input) !== item.inputKey) throw new Error("Imported input integrity mismatch");
  const candidate = JSON.parse(input).candidates.find(
    (node) => node.id === item.oracle.candidateId,
  );
  const label = candidate?.label || candidate?.text;
  if (!label) throw new Error("Controlled browser probe requires a labelled target");
  const suite = {
    version: "1",
    cases: [
      {
        id: item.id,
        dataset: item.dataset,
        family: item.family,
        split: item.split,
        category: "external-reconstruction",
        track: "derived-static-dom",
        fixture: reconstruction.fixture,
        instruction: item.instruction,
        viewport: { width: 1280, height: 800, tolerance: 1 },
        setupRevision: reconstructionVersion,
        review: {
          status: "source-mapping-validated",
          method:
            "Automated source adjacency and unique xid-to-selector mapping; no independent human review claimed",
        },
        expected: {
          outcome: "found",
          actions: [
            {
              step: 1,
              action: "click",
              outcome: "found",
              target: { selector: reconstruction.oracle.selector, frames: [] },
            },
          ],
        },
        provider: {
          actions: [{ step: 1, action: "click", outcome: "found", label, tag: candidate.tag }],
        },
        provenance: {
          ...item.provenance,
          actionLabelSource: "controlled-browser-probe",
          sourceActionLabel: "unavailable",
        },
        sourceCaseId: item.id,
        historicalState: reconstruction.historicalState,
        reconstructionLimitations: reconstruction.limitations,
      },
    ],
  };
  const output = resolve(values.output);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(suite, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { output, caseId: item.id, fixtureSha256: reconstruction.fixture.sha256 };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: Object.fromEntries(
        ["import", "source-root", "case", "output"].map((name) => [name, { type: "string" }]),
      ),
    });
    if (["import", "source-root", "case", "output"].some((name) => !values[name]))
      throw new Error("Specify --import DIR --source-root DIR --case ID --output NEW_PRIVATE_JSON");
    console.log(JSON.stringify(await createBrowserSuite(values)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
