// Test-only fixture instrumentation. Expected mappings arrive after capture/inference,
// remain in this closure, and are never written into DOM attributes or page text.
(() => {
  if (window.top !== window) return;
  const query = `?trial=${encodeURIComponent(new URL(location.href).searchParams.get("trial"))}`;
  let baseline;
  const nodeIds = new WeakMap();
  let nextNodeId = 1;
  function nodeId(node) {
    if (!nodeIds.has(node)) nodeIds.set(node, `node-${nextNodeId++}`);
    return nodeIds.get(node);
  }
  function eligible(node) {
    if (node?.nodeType !== 1 || !node.isConnected) return false;
    const doc = node.ownerDocument;
    const view = doc.defaultView;
    const modal = doc.querySelector("dialog:modal");
    if (modal && !modal.contains(node)) return false;
    if (["hidden", "collapse"].includes(view.getComputedStyle(node).visibility)) return false;
    for (let current = node; current; current = current.parentElement) {
      const css = view.getComputedStyle(current);
      if (
        current.matches("script,style,noscript,template,input[type=hidden]") ||
        current.hasAttribute("inert") ||
        (current.getAttribute("aria-hidden")?.toLowerCase() === "true" &&
          !current.contains(doc.activeElement)) ||
        css.display === "none" ||
        css.contentVisibility === "hidden"
      )
        return false;
      if (
        current.parentElement?.matches("details:not([open])") &&
        current !== current.parentElement.querySelector(":scope > summary")
      )
        return false;
    }
    return !view.frameElement || eligible(view.frameElement);
  }
  // Controlled fixture parity only; this is not a security or privacy hash.
  // The Node runner records source integrity separately with SHA-256.
  function checksum(value) {
    let result = 2166136261;
    for (let index = 0; index < value.length; index++)
      result = Math.imul(result ^ value.charCodeAt(index), 16777619);
    return `fnv1a32-utf16:${(result >>> 0).toString(16).padStart(8, "0")}`;
  }
  function environment() {
    const docs = documents();
    const identify = (node) => (node ? { tag: node.localName, id: node.id || null } : null);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      userAgent: navigator.userAgent,
      language: navigator.language,
      languages: [...navigator.languages],
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      initialState: docs.map((doc) => ({
        scroll: [doc.defaultView.scrollX, doc.defaultView.scrollY],
        active: identify(doc.activeElement),
        fields: [...doc.querySelectorAll("input,textarea,select,[contenteditable]")].map(
          (node) => ({
            ...identify(node),
            type: node.type ?? null,
            checked: node.checked ?? null,
            selectedIndex: node.selectedIndex ?? null,
            fieldStateChecksum: checksum(
              JSON.stringify({
                value: node.value ?? node.textContent,
                selected: node.options ? [...node.options].map((option) => option.selected) : null,
              }),
            ),
          }),
        ),
      })),
      documentChecksum: docs.map((doc) => {
        const clone = doc.documentElement.cloneNode(true);
        for (const node of clone.querySelectorAll("input,textarea,select,[contenteditable]")) {
          node.removeAttribute("value");
          if (node.matches("textarea,[contenteditable]")) node.textContent = "";
        }
        const html = clone.outerHTML.replace(/([?&](?:amp;)?trial=)[^&#"'<> ]*/gu, "$1normalized");
        return checksum(html);
      }),
    };
  }
  function documents() {
    const list = [document];
    for (let i = 0; i < list.length; i++)
      for (const frame of list[i].querySelectorAll("iframe"))
        if (frame.contentDocument) list.push(frame.contentDocument);
    return list;
  }
  function state() {
    return documents().map((doc) => ({
      scroll: [doc.defaultView.scrollX, doc.defaultView.scrollY],
      active: doc.activeElement,
      fields: [...doc.querySelectorAll("input,textarea,select,[contenteditable]")].map((node) => [
        node,
        node.value ?? node.textContent,
        node.checked,
        node.selectedIndex,
        node.options ? JSON.stringify([...node.options].map((option) => option.selected)) : null,
      ]),
    }));
  }
  function unchanged() {
    if (!baseline) return null;
    const current = state();
    return (
      current.length === baseline.length &&
      current.every(
        (item, i) =>
          JSON.stringify(item.scroll) === JSON.stringify(baseline[i].scroll) &&
          item.active === baseline[i].active &&
          item.fields.length === baseline[i].fields.length &&
          item.fields.every((field, j) =>
            field.every((value, k) => value === baseline[i].fields[j][k]),
          ),
      )
    );
  }
  function expectedNode(target) {
    if (!target) return null;
    let doc = document;
    for (const selector of target.frames ?? []) {
      const nodes = doc.querySelectorAll(selector);
      if (nodes.length !== 1 || !nodes[0].contentDocument)
        throw new Error("Expected frame mapping is not unique");
      doc = nodes[0].contentDocument;
    }
    const nodes = doc.querySelectorAll(target.selector);
    if (nodes.length !== 1) throw new Error("Expected target mapping is not unique");
    return nodes[0];
  }
  function matches(target, xpath) {
    let doc = document;
    for (const frame of target.frame?.chain ?? []) {
      const nodes = doc.evaluate(frame.xpath, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
      if (nodes.snapshotLength !== 1 || !nodes.snapshotItem(0).contentDocument) return [];
      doc = nodes.snapshotItem(0).contentDocument;
    }
    const nodes = doc.evaluate(xpath, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
    return Array.from({ length: nodes.snapshotLength }, (_, i) => nodes.snapshotItem(i));
  }
  function observe(command) {
    const expected = command.expected.map(expectedNode);
    const actions = (command.actions ?? []).map((action, i) => ({
      matches: (action.target?.xpaths ?? []).map((xpath) => {
        try {
          const nodes = matches(action.target, xpath);
          return {
            count: nodes.length,
            intended: nodes.length === 1 && nodes[0] === expected[i],
            expectedIndices:
              nodes.length === 1
                ? expected.flatMap((node, index) => (node === nodes[0] ? [index] : []))
                : [],
            nodeId: nodes.length === 1 ? nodeId(nodes[0]) : null,
            eligible: nodes.length === 1 && eligible(nodes[0]),
          };
        } catch {
          return {
            count: 0,
            intended: false,
            expectedIndices: [],
            nodeId: null,
            eligible: false,
            invalid: true,
          };
        }
      }),
    }));
    const targets = expected.filter(Boolean);
    const captured = new Set(),
      modelInput = new Set();
    for (const candidate of command.coverageTargets ?? [])
      for (const xpath of candidate.xpaths) {
        const nodes = matches(candidate, xpath);
        if (nodes.length === 1 && targets.includes(nodes[0])) {
          captured.add(nodes[0]);
          if (command.modelInputIds?.includes(candidate.candidateId)) modelInput.add(nodes[0]);
        }
      }
    return {
      actions,
      viewport: { width: innerWidth, height: innerHeight },
      userAgent: navigator.userAgent,
      passiveStateUnchanged: unchanged(),
      captureCoverage: { expected: new Set(targets).size, found: captured.size },
      modelInputCoverage: { expected: new Set(targets).size, found: modelInput.size },
    };
  }
  function mutate(mutation) {
    const node = expectedNode(mutation.target);
    switch (mutation.kind) {
      case "wrapper": {
        const wrapper = document.createElement("div");
        node.before(wrapper);
        wrapper.append(node);
        break;
      }
      case "sibling": {
        const sibling = document.createElement("span");
        sibling.textContent = "Updated details";
        node.before(sibling);
        break;
      }
      case "class":
        node.className = "updated-theme";
        break;
      case "id":
        node.id = "save-profile-updated";
        break;
      case "duplicate": {
        const clone = node.cloneNode(true);
        clone.id = "other-save";
        node.ownerDocument.body.prepend(clone);
        break;
      }
      case "rerender":
        node.replaceWith(node.cloneNode(true));
        break;
      case "remove":
        node.remove();
        break;
      case "replacement": {
        const clone = node.cloneNode(true);
        clone.textContent = "Cancel replacement";
        node.replaceWith(clone);
        break;
      }
      default:
        throw new Error("Unknown mutation");
    }
  }
  async function poll() {
    try {
      const command = await (await fetch(`/command${query}`)).json();
      if (command) {
        let result;
        try {
          if (command.kind === "baseline") {
            const deadline = performance.now() + 10000;
            while (
              documents().some(
                (doc) =>
                  doc.readyState !== "complete" || (doc !== document && doc.URL === "about:blank"),
              )
            ) {
              if (performance.now() > deadline)
                throw new Error("Fixture documents did not finish loading");
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            if (command.setup?.scroll)
              scrollTo(command.setup.scroll.x ?? 0, command.setup.scroll.y ?? 0);
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
            baseline = state();
            result = environment();
          } else if (command.kind === "mutate") {
            mutate(command.mutation);
            baseline = state();
            result = observe(command);
          } else if (command.kind === "observe") result = observe(command);
          else throw new Error("Unknown oracle command");
        } catch (error) {
          result = { error: error.message };
        }
        await fetch(`/observation${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: command.id, ...result }),
        });
      }
    } finally {
      setTimeout(poll, 25);
    }
  }
  poll();
})();
