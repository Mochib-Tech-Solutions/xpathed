import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import { gunzipSync } from "node:zlib";

const { JSDOM } = createRequire(new URL("../src/Web/package.json", import.meta.url))("jsdom");

export const transformationVersion = "external-targets-v1";
const text = (value) =>
  typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, 1000) : "";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const preparedPages = new WeakMap();
const editable = (node) =>
  node.attributes?.contenteditable !== undefined && node.attributes.contenteditable !== "false";

function record(source, provenance, family, id) {
  return {
    id: `${provenance.dataset}-${digest(`${family}:${id}`).slice(0, 24)}`,
    dataset: provenance.dataset,
    split: provenance.split,
    family,
    status: "offline-eligible",
    reasons: [],
    track: "offline-target-selection",
    historicalState: "unavailable",
    transformationVersion,
    provenance: { ...provenance, originalId: id },
    source,
    candidates: [],
    oracle: null,
  };
}

function fail(result, reason, status = "excluded") {
  result.status = status;
  result.reasons.push(reason);
  return result;
}

function candidate(index, node, content) {
  const attrs = node.attributes ?? {};
  return {
    id: `n${index + 1}`,
    tag: String(node.tag ?? "").toLowerCase(),
    ...Object.fromEntries(
      Object.entries({
        text: text(content),
        role: text(attrs.role),
        label: text(attrs["aria-label"] ?? attrs.aria_label ?? attrs.label ?? attrs.title),
        placeholder: text(attrs.placeholder),
      }).filter(([, value]) => value),
    ),
  };
}

export function adaptPhraseNode(annotation, page, provenance) {
  if (!annotation || typeof annotation !== "object" || Array.isArray(annotation))
    return fail(
      record({}, provenance, "invalid", `line-${provenance.sourceLine ?? "unknown"}`),
      "invalid-annotation",
    );
  const family = `${annotation.version}/${annotation.webpage}`;
  const result = record(
    {
      version: annotation.version,
      webpage: annotation.webpage,
      xid: annotation.xid,
      equivalentSourceIds: annotation.equiv ?? [],
    },
    provenance,
    family,
    annotation.exampleId,
  );
  result.instruction = annotation.phrase;
  if (
    !annotation.exampleId ||
    !annotation.version ||
    !annotation.webpage ||
    !text(annotation.phrase) ||
    !Number.isInteger(annotation.xid)
  )
    return fail(result, "invalid-annotation");
  if (!page) return fail(result, "missing-page", "reconstruction-limited");
  if (
    !Array.isArray(page.info) ||
    page.info.some(
      (node) =>
        !node ||
        typeof node !== "object" ||
        typeof node.tag !== "string" ||
        (node.children !== undefined && !Array.isArray(node.children)),
    )
  )
    return fail(result, "invalid-page");
  const targets = page.info.filter((node) => node.xid === annotation.xid);
  if (targets.length !== 1)
    return fail(result, targets.length ? "duplicate-target-id" : "missing-target-id");
  const target = targets[0];
  if (Array.isArray(annotation.equiv) && new Set(annotation.equiv).size > 1)
    return fail(result, "source-equivalence-review-required");
  const style = (node, key) => node.styles?.[key] ?? page.common_styles?.[key];
  const hidden = (node) =>
    node.attributes?.hidden !== undefined ||
    ["true", true].includes(node.attributes?.["aria-hidden"]) ||
    style(node, "display") === "none" ||
    style(node, "content-visibility") === "hidden";
  const invisible = (node) => ["hidden", "collapse"].includes(style(node, "visibility"));
  const frameScope = (node) =>
    ["iframe", "frame", "shadow-root"].includes(String(node.tag).toLowerCase());
  const parents = new Map();
  for (const node of page.info)
    for (const child of node.children ?? []) {
      if (!Number.isInteger(child) || !page.info[child] || parents.has(page.info[child]))
        return fail(result, "invalid-page-tree");
      parents.set(page.info[child], node);
    }
  function ancestry(node) {
    const chain = new Set();
    while (node) {
      if (chain.has(node)) throw new Error("cycle");
      chain.add(node);
      node = parents.get(node);
    }
    return [...chain];
  }
  try {
    for (const node of page.info) ancestry(node);
    if (ancestry(target).some(frameScope))
      return fail(result, "unsupported-frame-scope", "unsupported");
    if (ancestry(target).some(hidden) || invisible(target))
      return fail(result, "accessibility-hidden-target");
    const nodes = page.info.filter(
      (node) =>
        !["t", "script", "style", "noscript"].includes(String(node.tag).toLowerCase()) &&
        !ancestry(node).some(frameScope) &&
        !ancestry(node).some(hidden) &&
        !invisible(node) &&
        !ancestry(node).slice(1).some(editable),
    );
    function content(node, depth = 0) {
      if (
        depth > 100 ||
        ["input", "textarea", "script", "style", "noscript"].includes(
          String(node.tag).toLowerCase(),
        ) ||
        frameScope(node) ||
        hidden(node) ||
        invisible(node) ||
        editable(node)
      )
        return "";
      return text(
        node.text ?? (node.children ?? []).map((i) => content(page.info[i], depth + 1)).join(" "),
      );
    }
    if (!preparedPages.has(page))
      preparedPages.set(
        page,
        nodes.map((node, index) => candidate(index, node, content(node))),
      );
    result.candidates = preparedPages.get(page);
    const index = nodes.indexOf(target);
    if (index < 0) return fail(result, "unsupported-target-node", "unsupported");
    result.oracle = {
      sourceTargetId: String(annotation.xid),
      candidateId: result.candidates[index].id,
    };
    return result;
  } catch {
    return fail(result, "invalid-page-tree");
  }
}

export function adaptMind2Web(task, action, actionIndex, provenance, adaptation) {
  if (!task || typeof task !== "object" || !action || typeof action !== "object")
    return fail(
      record({}, provenance, task?.annotation_id ?? "invalid", `action-${actionIndex}`),
      "invalid-annotation",
    );
  const result = record(
    {
      annotationId: task.annotation_id,
      actionUid: action.action_uid,
      actionIndex,
      website: task.website,
      domain: task.domain,
      subdomain: task.subdomain,
      originalOperation: action.operation?.original_op,
      operation: action.operation?.op,
    },
    provenance,
    task.annotation_id,
    action.action_uid,
  );
  if (!task.annotation_id || !action.action_uid || typeof action.raw_html !== "string")
    return fail(result, "invalid-annotation");
  const window = new JSDOM(action.raw_html).window;
  try {
    const document = window.document;
    const nodes = [...document.querySelectorAll("*")];
    const targets = nodes.filter((node) =>
      [
        node.getAttribute("data_pw_testid_buckeye"),
        node.getAttribute("data-pw-testid-buckeye"),
      ].includes(action.action_uid),
    );
    if (targets.length !== 1)
      return fail(result, targets.length ? "duplicate-target-id" : "missing-target-id");
    const target = targets[0];
    const targetId = target.getAttribute("backend_node_id");
    if (
      !targetId ||
      nodes.filter((node) => node.getAttribute("backend_node_id") === targetId).length !== 1
    )
      return fail(result, "ambiguous-backend-node-id");
    const original = (action.pos_candidates ?? []).filter((node) => node.is_original_target);
    if (
      original.length > 1 ||
      (original.length === 1 && String(original[0].backend_node_id) !== targetId)
    )
      return fail(result, "conflicting-original-target");
    result.source.rawOnlyTarget = original.length === 0;
    if (target.closest("iframe, frame, shadow-root"))
      return fail(result, "unsupported-frame-scope", "unsupported");
    const inlineInvisible = (node) => {
      for (let current = node; current; current = current.parentElement) {
        const visibility = current.style.visibility.toLowerCase();
        if (["visible", "initial"].includes(visibility)) return false;
        if (["hidden", "collapse"].includes(visibility)) return true;
      }
      return false;
    };
    if (
      target.closest('[hidden], [aria-hidden="true"], [aria_hidden="true"]') ||
      inlineInvisible(target)
    )
      return fail(result, "accessibility-hidden-target");
    const sourceAction = {
      CLICK: "click",
      TYPE: "type",
      SELECT: "select",
      HOVER: "hover",
      ENTER: "press",
    }[action.operation?.original_op || action.operation?.op];
    if (!sourceAction) return fail(result, "unsupported-source-operation", "unsupported");
    result.action = sourceAction;
    // Never execute scripts or load resources. Only allow semantic text/attributes into input.
    for (const node of document.querySelectorAll(
      'iframe, frame, shadow-root, [hidden], [aria-hidden="true"], [aria_hidden="true"]',
    ))
      node.remove();
    for (const node of document.querySelectorAll("[style]"))
      if (
        node.style.display === "none" ||
        node.style.getPropertyValue("content-visibility") === "hidden"
      )
        node.remove();
    for (const node of document.querySelectorAll(
      'input, textarea, script, style, noscript, [contenteditable]:not([contenteditable="false"])',
    )) {
      node.textContent = "";
      node.removeAttribute("value");
    }
    if (!target.isConnected) return fail(result, "sanitization-removed-target");
    for (const node of document.querySelectorAll("*"))
      if (inlineInvisible(node))
        for (const child of node.childNodes)
          if (child.nodeType === window.Node.TEXT_NODE) child.textContent = "";
    const candidates = [...document.querySelectorAll("*")].filter(
      (node) =>
        !["SCRIPT", "STYLE", "NOSCRIPT", "TEXT"].includes(node.tagName) &&
        !inlineInvisible(node) &&
        !node.closest(
          '[hidden], [aria-hidden="true"], [aria_hidden="true"], iframe, frame, shadow-root',
        ),
    );
    result.candidates = candidates.map((node, index) =>
      candidate(
        index,
        {
          tag: node.localName,
          attributes: Object.fromEntries(
            [...node.attributes].map((attr) => [attr.name, attr.value]),
          ),
        },
        node.textContent,
      ),
    );
    const index = candidates.indexOf(target);
    if (index < 0) return fail(result, "unsupported-target-node", "unsupported");
    result.oracle = { sourceTargetId: targetId, candidateId: result.candidates[index].id };
    if (
      !adaptation?.reviewed ||
      !adaptation.targetHiddenDuringAuthoring ||
      !text(adaptation.instruction) ||
      !text(adaptation.author) ||
      !text(adaptation.reviewer) ||
      adaptation.author === adaptation.reviewer ||
      !text(adaptation.policyVersion)
    )
      return fail(result, "independent-instruction-required", "adaptation-required");
    if ((task.action_reprs ?? []).includes(adaptation.instruction))
      return fail(result, "gold-action-as-instruction");
    if (adaptation.action !== sourceAction) return fail(result, "adaptation-action-conflict");
    result.instruction = adaptation.instruction;
    result.provenance.adaptation = { ...adaptation };
    return result;
  } finally {
    window.close();
  }
}

export function buildInventory(cases) {
  const inventory = {
    version: 1,
    total: cases.length,
    statuses: {},
    reasons: {},
    splits: {},
    historicalReplayable: 0,
    uncountedActionTasks: 0,
  };
  for (const item of cases) {
    if (item.source.actionsUnknown) inventory.uncountedActionTasks++;
    inventory.statuses[item.status] = (inventory.statuses[item.status] ?? 0) + 1;
    for (const reason of item.reasons)
      inventory.reasons[reason] = (inventory.reasons[reason] ?? 0) + 1;
    const split = (inventory.splits[item.split] ??= { total: 0, statuses: {} });
    split.total++;
    split.statuses[item.status] = (split.statuses[item.status] ?? 0) + 1;
  }
  return inventory;
}

async function* tasksFromFile(path, maxCharacters) {
  let started = false,
    ended = false,
    quoted = false,
    escaped = false,
    depth = 0,
    value = "",
    oversized = false,
    afterComma = false,
    index = 0;
  function finish() {
    const item = { index: index++ };
    if (oversized) item.error = "task-size-limit";
    else
      try {
        item.task = JSON.parse(value);
      } catch {
        item.error = "invalid-json-record";
      }
    value = "";
    oversized = false;
    return item;
  }
  for await (const chunk of createReadStream(path, { encoding: "utf8" }))
    for (const character of chunk) {
      if (!started) {
        if (/\s/.test(character)) continue;
        if (character !== "[") throw new Error("Mind2Web task file must be an array");
        started = true;
        continue;
      }
      if (ended) {
        if (!/\s/.test(character)) throw new Error("Unexpected data after task array");
        continue;
      }
      if (!quoted && depth === 0 && (character === "," || character === "]")) {
        if (!oversized && !value.trim()) {
          if (character === "," || afterComma) throw new Error("Empty task array entry");
        } else yield finish();
        afterComma = character === ",";
        ended = character === "]";
        continue;
      }
      if (!oversized) {
        value += character;
        if (value.length > maxCharacters) {
          value = "";
          oversized = true;
        }
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{" || character === "[") depth++;
      else if (character === "}" || character === "]") {
        depth--;
        if (depth < 0) throw new Error("Invalid task array nesting");
      }
    }
  if (!started || !ended || quoted || depth !== 0) throw new Error("Incomplete task array");
}

export async function importDataset(
  manifest,
  { sourceRoot, outputRoot, maxTaskCharacters = 64 * 1024 * 1024 },
) {
  if (
    !Number.isSafeInteger(maxTaskCharacters) ||
    maxTaskCharacters < 1 ||
    maxTaskCharacters > 256 * 1024 * 1024
  )
    throw new Error("Invalid task character limit");
  if (
    manifest.version !== 1 ||
    !["phrasenode", "mind2web"].includes(manifest.dataset) ||
    !text(manifest.revision) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length
  )
    throw new Error("Invalid dataset manifest");
  const root = await realpath(sourceRoot);
  const verified = new Map();
  for (const file of manifest.files) {
    const allowedKinds = manifest.dataset === "phrasenode" ? ["commands", "page"] : ["tasks"];
    if (!allowedKinds.includes(file.kind)) throw new Error("Invalid source file kind");
    if (
      !file.path ||
      isAbsolute(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !/^https:\/\//.test(file.url ?? "")
    )
      throw new Error("Invalid source file provenance");
    const path = await realpath(resolve(root, file.path));
    const rel = relative(root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Source path escapes source root");
    if (verified.has(file.path)) throw new Error("Duplicate source file");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    if (hash.digest("hex") !== file.sha256)
      throw new Error(`Source checksum mismatch: ${file.path}`);
    verified.set(file.path, { ...file, bytes, absolutePath: path });
  }
  // Reserve a new directory; never overwrite a previous import or its immutable inventory.
  await mkdir(outputRoot, { mode: 0o700 });
  await mkdir(join(outputRoot, "inputs"), { mode: 0o700 });
  const cases = [];
  const writtenInputs = new Set();
  const inputKeys = new WeakMap();
  async function save(item) {
    if (item.candidates.length) {
      item.inputKey = inputKeys.get(item.candidates);
      if (!item.inputKey) {
        const input = JSON.stringify({ candidates: item.candidates }) + "\n";
        item.inputKey = digest(input);
        inputKeys.set(item.candidates, item.inputKey);
        if (!writtenInputs.has(item.inputKey)) {
          await writeFile(join(outputRoot, "inputs", `${item.inputKey}.json`), input, {
            flag: "wx",
            mode: 0o600,
          });
          writtenInputs.add(item.inputKey);
        }
      }
    }
    delete item.candidates;
    cases.push(item);
  }
  const provenance = (file) => ({
    dataset: manifest.dataset,
    revision: manifest.revision,
    split: file.split,
    sourceUrl: file.url,
    sourcePath: file.path,
    sourceSha256: file.sha256,
  });
  if (manifest.dataset === "phrasenode") {
    const pages = new Map();
    for (const file of verified.values())
      if (file.kind === "page") {
        if (!file.page || pages.has(file.page)) throw new Error("Duplicate or missing page key");
        pages.set(file.page, file);
      }
    const groups = new Map();
    for (const file of verified.values())
      if (file.kind === "commands") {
        if (!["train", "dev", "test"].includes(file.split))
          throw new Error(
            "Invalid PhraseNode original split; do not import the all file alongside splits",
          );
        const lines = (await readFile(file.absolutePath, "utf8")).split(/\r?\n/);
        for (let line = 0; line < lines.length; line++) {
          if (!lines[line].trim()) continue;
          let annotation;
          try {
            annotation = JSON.parse(lines[line]);
          } catch {
            await save(
              fail(
                record({}, provenance(file), `invalid/${file.path}`, `line-${line + 1}`),
                "invalid-json-record",
              ),
            );
            continue;
          }
          const key = `${annotation?.version}/${annotation?.webpage}`;
          if (!groups.has(key)) groups.set(key, []);
          groups
            .get(key)
            .push({ annotation, provenance: { ...provenance(file), sourceLine: line + 1 } });
        }
      }
    for (const [key, examples] of groups) {
      const file = pages.get(key);
      let page;
      let pageError;
      if (file)
        try {
          let bytes = await readFile(file.absolutePath);
          if (file.path.endsWith(".gz"))
            bytes = gunzipSync(bytes, { maxOutputLength: 100 * 1024 * 1024 });
          page = JSON.parse(bytes.toString("utf8"));
        } catch {
          pageError = "invalid-page-asset";
        }
      for (const { annotation, provenance: p } of examples) {
        const item = adaptPhraseNode(annotation, page, p);
        if (file) item.provenance.page = { path: file.path, url: file.url, sha256: file.sha256 };
        if (pageError) {
          item.status = "reconstruction-limited";
          item.reasons = [pageError];
        }
        await save(item);
      }
    }
  } else {
    const adaptations = new Map();
    for (const adaptation of manifest.adaptations ?? []) {
      const key = `${adaptation.annotationId}/${adaptation.actionUid}`;
      if (adaptations.has(key)) throw new Error("Duplicate instruction adaptation");
      adaptations.set(key, adaptation);
    }
    for (const file of verified.values())
      if (file.kind === "tasks") {
        if (!["train", "test_task", "test_website", "test_domain"].includes(file.split))
          throw new Error("Invalid Mind2Web original split");
        for await (const entry of tasksFromFile(file.absolutePath, maxTaskCharacters)) {
          if (entry.error) {
            await save(
              fail(
                record(
                  { actionsUnknown: true },
                  provenance(file),
                  `invalid/${file.path}`,
                  `task-${entry.index}`,
                ),
                entry.error,
              ),
            );
            continue;
          }
          const { task } = entry;
          if (!task || !Array.isArray(task.actions) || task.actions.length === 0) {
            await save(
              fail(
                record(
                  {},
                  provenance(file),
                  task?.annotation_id ?? "invalid",
                  task?.annotation_id ?? `task-${entry.index}`,
                ),
                "missing-task-actions",
              ),
            );
            continue;
          }
          for (const [index, action] of task.actions.entries()) {
            const adaptation = adaptations.get(`${task.annotation_id}/${action?.action_uid}`);
            await save(adaptMind2Web(task, action, index, provenance(file), adaptation));
          }
        }
      }
  }
  const byId = new Map();
  const families = new Map();
  for (const item of cases) {
    if (!byId.has(item.id)) byId.set(item.id, []);
    byId.get(item.id).push(item);
    if (!families.has(item.family)) families.set(item.family, []);
    families.get(item.family).push(item);
  }
  for (const group of byId.values())
    if (group.length > 1) for (const item of group) fail(item, "duplicate-original-id");
  for (const group of families.values())
    if (new Set(group.map((item) => item.split)).size > 1)
      for (const item of group) fail(item, "family-split-leakage");
  if (manifest.dataset === "mind2web") {
    const train = cases.filter((item) => item.split === "train");
    const websites = new Set(train.map((item) => item.source.website).filter(Boolean));
    const domains = new Set(train.map((item) => item.source.domain).filter(Boolean));
    for (const item of cases) {
      if (item.split === "test_website" && websites.has(item.source.website))
        fail(item, "website-split-leakage");
      if (item.split === "test_domain" && domains.has(item.source.domain))
        fail(item, "domain-split-leakage");
    }
  }
  const inventory = { ...buildInventory(cases), inputs: writtenInputs.size };
  const savedManifest = {
    ...manifest,
    transformationVersion,
    manifestSha256: digest(JSON.stringify(manifest)),
    casesSha256: digest(JSON.stringify(cases, null, 2) + "\n"),
    inventorySha256: digest(JSON.stringify(inventory, null, 2) + "\n"),
    files: [...verified.values()].map(({ absolutePath, ...file }) => file),
  };
  for (const [name, value] of [
    ["manifest", savedManifest],
    ["inventory", inventory],
    ["cases", cases],
  ])
    await writeFile(join(outputRoot, `${name}.json`), JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  return { manifest: savedManifest, inventory, cases };
}

if (import.meta.main) {
  try {
    const { parseArgs } = await import("node:util");
    const { dirname } = await import("node:path");
    const { values } = parseArgs({
      options: {
        manifest: { type: "string" },
        output: { type: "string" },
        "source-root": { type: "string" },
      },
    });
    if (!values.manifest || !values.output)
      throw new Error("Specify --manifest SOURCE_MANIFEST and --output NEW_IMPORT_DIRECTORY");
    const manifestPath = resolve(values.manifest);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const result = await importDataset(manifest, {
      sourceRoot: resolve(values["source-root"] ?? dirname(manifestPath)),
      outputRoot: resolve(values.output),
    });
    console.log(JSON.stringify(result.inventory, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
