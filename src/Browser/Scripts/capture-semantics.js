const normalize = (value) => (value ?? "").replace(/\s+/gu, " ").trim().normalize("NFC");
const valueContainer = 'input,textarea,select,[contenteditable]:not([contenteditable="false"])';
const buttonInput = "input[type=button],input[type=submit],input[type=reset]";
const ignored = "script,style,noscript,template,[data-private],[data-sensitive]";
const cssFor = (element) => {
  if (!styleCache.has(element)) styleCache.set(element, getComputedStyle(element));
  return styleCache.get(element);
};
const rectFor = (element) => {
  if (!rectCache.has(element)) rectCache.set(element, element.getBoundingClientRect());
  return rectCache.get(element);
};
const exposed = (element) => {
  if (exposureCache.has(element)) return exposureCache.get(element);
  const ancestors = [];
  let current = element;
  while (current && !exposureCache.has(current)) {
    checkBudget();
    ancestors.push(current);
    current = parent(current);
  }
  let allowed = current ? exposureCache.get(current) : true;
  while (ancestors.length) {
    current = ancestors.pop();
    const css = cssFor(current);
    const hiddenAria =
      current.getAttribute("aria-hidden")?.toLowerCase() === "true" &&
      !contains(current, activeElement());
    const inert =
      current.hasAttribute("inert") && !(modal && current !== modal && contains(current, modal));
    allowed =
      allowed &&
      !current.matches(`${ignored},input[type=hidden]`) &&
      !inert &&
      !hiddenAria &&
      css.display !== "none" &&
      css.contentVisibility !== "hidden";
    const disclosure = parent(current);
    if (
      disclosure?.matches("details:not([open])") &&
      current !== disclosure.querySelector(":scope > summary")
    )
      allowed = false;
    exposureCache.set(current, allowed);
  }
  return allowed;
};
const accessibilityExposed = (element) =>
  environment.exposed &&
  (!modal || contains(modal, element)) &&
  exposed(element) &&
  !["hidden", "collapse"].includes(cssFor(element).visibility);
const rendered = (element) => {
  const rect = rectFor(element);
  if (
    !environment.rendered ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    !accessibilityExposed(element)
  )
    return false;
  for (let current = element; current; current = parent(current)) {
    checkBudget();
    if (Number(cssFor(current).opacity) === 0) return false;
  }
  return true;
};
const nameText = (reference, references) =>
  reference && !closest(reference, ignored)
    ? privacySource(
        reference,
        normalize(reference.getAttribute("aria-label")) ||
          normalize(reference.getAttribute("alt")) ||
          text(reference, !accessibilityExposed(reference), references),
      )
    : "";
const text = (element, includeHidden = false, references = new Set()) => {
  if (!element || element.matches(valueContainer) || closest(element, ignored)) return "";
  if (references.has(element)) return "";
  const cacheable = !includeHidden && references.size === 0;
  if (cacheable && textCache.has(element)) return textCache.get(element);
  references = new Set(references).add(element);
  const parts = [];
  const pending = [];
  const children = (node) => {
    const children =
      node.shadowRoot?.childNodes ??
      (node.localName === "slot" && node.assignedNodes().length
        ? node.assignedNodes({ flatten: true })
        : node.childNodes);
    for (let index = children.length - 1; index >= 0; index--) {
      checkBudget();
      pending.push(children[index]);
    }
  };
  children(element);
  while (pending.length) {
    checkBudget();
    const node = pending.pop();
    const parent = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (
      !parent ||
      closest(parent, `${valueContainer},${ignored}`) ||
      (!includeHidden && !accessibilityExposed(parent))
    )
      continue;
    if (node.nodeType === Node.TEXT_NODE) parts.push(privacySource(parent, node.textContent));
    else if (node.nodeType === Node.ELEMENT_NODE) {
      const referencedName = normalize(
        (node.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/u)
          .map((id) => nameText(parent.getRootNode().getElementById(id), references))
          .join(" "),
      );
      if (referencedName) parts.push(referencedName);
      else if (normalize(node.getAttribute("aria-label")))
        parts.push(privacySource(node, node.getAttribute("aria-label")));
      else if (node.localName === "img") parts.push(privacySource(node, node.getAttribute("alt")));
      else children(node);
    }
  }
  const result = normalize(parts.join(" "));
  if (cacheable) textCache.set(element, result);
  return result;
};
const label = (element) => {
  if (labelCache.has(element)) return labelCache.get(element);
  const result =
    normalize(
      (element.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/u)
        .map((id) => nameText(element.getRootNode().getElementById(id)))
        .join(" "),
    ) ||
    normalize(element.getAttribute("aria-label")) ||
    normalize(Array.from(element.labels ?? [], (reference) => nameText(reference)).join(" ")) ||
    normalize(element.getAttribute("alt")) ||
    (element.matches(buttonInput) ? normalize(element.value) : "") ||
    (element.matches("button,a[href],summary,[role=button],[role=checkbox],[role=radio]")
      ? text(element)
      : "") ||
    normalize(element.getAttribute("title"));
  labelCache.set(element, result);
  privacySource(element, result);
  return result;
};
const headingScopeRoles = new Set(
  "article complementary navigation main region group form dialog alertdialog listitem figure table grid treegrid row cell columnheader rowheader gridcell treeitem tabpanel".split(
    " ",
  ),
);
const headingFor = (element) => {
  if (element === document.body || element === document.documentElement) return null;
  if (headingCache.has(element)) return headingCache.get(element);
  const pending = [{ element, next: element.firstElementChild }];
  while (pending.length) {
    checkBudget();
    const current = pending.at(-1),
      node = current.next;
    if (!node) {
      headingCache.set(current.element, null);
      pending.pop();
      continue;
    }
    current.next = node.nextElementSibling;
    if (
      closest(node, `${valueContainer},${ignored}`) ||
      !exposed(node) ||
      node.matches(
        "section,article,aside,nav,main,fieldset,form,dialog,li,figure,table,tr,td,th",
      ) ||
      headingScopeRoles.has(role(node)) ||
      repeatedItem(node)
    )
      continue;
    const heading =
      node.matches("legend,h1,h2,h3,h4,h5,h6") && accessibilityExposed(node) && text(node)
        ? node
        : headingCache.get(node);
    if (heading) {
      for (const entry of pending) headingCache.set(entry.element, heading);
      return heading;
    }
    if (!headingCache.has(node)) pending.push({ element: node, next: node.firstElementChild });
  }
  return null;
};
const scope = (element) => {
  const scopes = [];
  const row = closest(element, "tr,[role=row]");
  for (
    let ancestor = parent(element);
    ancestor && ancestor !== document.body;
    ancestor = parent(ancestor)
  ) {
    checkBudget();
    const context =
      label(ancestor) ||
      (ancestor === row ? text(ancestor) : "") ||
      (ancestor.matches("header,footer,nav,main,aside") ? ancestor.localName : "") ||
      text(headingFor(ancestor));
    if (context && !scopes.includes(context)) scopes.push(context);
  }
  return scopes;
};
const roles = new Set(
  "alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript suggestion superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem".split(
    " ",
  ),
);
const role = (element) => {
  const explicit = (element.getAttribute("role") ?? "")
    .split(/\s+/u)
    .find((value) => roles.has(value));
  const presentationConflict =
    ["none", "presentation"].includes(explicit) &&
    ((!element.matches(":disabled") &&
      (element.tabIndex >= 0 || element.hasAttribute("tabindex"))) ||
      element.matches(
        "[aria-label],[aria-labelledby],[aria-describedby],[aria-description],[aria-controls],[aria-owns],[aria-live],[aria-busy],[aria-current]",
      ));
  if (explicit && !presentationConflict) return explicit;
  return element.localName === "select"
    ? element.multiple || element.size > 1
      ? "listbox"
      : "combobox"
    : element.localName === "a"
      ? element.hasAttribute("href")
        ? "link"
        : ""
      : ({ button: "button", textarea: "textbox", summary: "button", img: "img" }[
          element.localName
        ] ??
        (element.localName === "input"
          ? ({
              checkbox: "checkbox",
              radio: "radio",
              button: "button",
              submit: "button",
              reset: "button",
              image: "button",
              number: "spinbutton",
              range: "slider",
              search: element.list ? "combobox" : "searchbox",
              text: element.list ? "combobox" : "textbox",
              email: element.list ? "combobox" : "textbox",
              tel: element.list ? "combobox" : "textbox",
              url: element.list ? "combobox" : "textbox",
            }[element.type] ?? "")
          : ""));
};
const textControl = (element) =>
  element.isContentEditable ||
  element.localName === "textarea" ||
  (element.localName === "input" &&
    ["text", "search", "email", "url", "tel", "password", "number"].includes(element.type));
const fillControl = (element) =>
  textControl(element) ||
  (element.localName === "input" &&
    ["date", "month", "week", "time", "datetime-local"].includes(element.type));
