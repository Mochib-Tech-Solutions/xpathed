const repeatedItem = (element) => {
  if (
    !element.matches("div,section,article,li,figure") ||
    element.children.length < 2 ||
    !element.parentElement
  )
    return false;
  const parent = element.parentElement;
  if (!siblingShapes.has(parent)) {
    const counts = new Map();
    for (const sibling of parent.children) {
      checkBudget();
      const key = shape(sibling);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    siblingShapes.set(parent, counts);
  }
  if (siblingShapes.get(parent).get(shape(element)) < 2) return false;
  // Retain repeated content items, not every layout wrapper or a copy of one control.
  const names = new Set();
  for (const child of element.querySelectorAll(
    "a[href],button,img[alt],h1,h2,h3,h4,h5,h6,[role=button],[role=heading]",
  )) {
    checkBudget();
    if (!accessibilityExposed(child)) continue;
    const name = label(child) || text(child);
    if (name) names.add(name);
    if (names.size >= 2) return true;
  }
  // A picture and its separate control can identify an item without a text title.
  let graphic;
  for (const child of element.querySelectorAll("img,svg,canvas,video")) {
    checkBudget();
    if (
      !rendered(child) ||
      closest(child, `${valueContainer},button,[role=button]`) ||
      closest(child.parentElement, "img,svg,canvas,video")
    )
      continue;
    if (graphic) return false;
    graphic = child;
  }
  if (!graphic) return false;
  for (const control of element.querySelectorAll("a[href],button,[role=button],[role=link]")) {
    checkBudget();
    if (
      accessibilityExposed(control) &&
      !closest(control, valueContainer) &&
      !control.contains(graphic) &&
      !graphic.contains(control)
    )
      return true;
  }
  return false;
};
const eligible = (element) => {
  const explicit = element.matches(
    'a[href],button,input,select,textarea,summary,img,svg,canvas,video,[aria-label],[aria-labelledby],[role],[tabindex],[contenteditable]:not([contenteditable="false"])',
  );
  if (!explicit && !element.hasChildNodes()) return false;
  if (!accessibilityExposed(element)) return false;
  const container = closest(element, valueContainer);
  if (container && container !== element) return false;
  return (
    explicit ||
    (!closest(
      element,
      'button,a,textarea,select,[contenteditable]:not([contenteditable="false"])',
    ) &&
      ([...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && normalize(node.textContent),
      ) ||
        repeatedItem(element)))
  );
};
const complexEffects = (element) => {
  if (environment.complexEffects) return true;
  for (let ancestor = element; ancestor; ancestor = parent(ancestor)) {
    checkBudget();
    const style = cssFor(ancestor);
    if (
      Number(style.opacity) !== 1 ||
      style.filter !== "none" ||
      style.mixBlendMode !== "normal" ||
      (style.backdropFilter && style.backdropFilter !== "none") ||
      (style.maskImage && style.maskImage !== "none")
    ) {
      return true;
    }
  }
  return false;
};
const appearance = (element) => {
  const css = cssFor(element);
  const limitations = complexEffects(element) ? ["complex_effects"] : [];
  if (css.backgroundImage !== "none") limitations.push("background_image");
  if (
    element.matches("img,svg,canvas,video,object,embed") ||
    element.querySelector("img,svg,canvas,video,object,embed")
  )
    limitations.push("replaced_content");
  if (
    ["::before", "::after"].some((pseudo) => {
      const style = getComputedStyle(element, pseudo);
      return !["none", "normal"].includes(style.content) && style.display !== "none";
    })
  )
    limitations.push("pseudo_element_appearance");
  if (limitations.length)
    return { backgroundColor: null, textColor: null, borderColor: null, limitations };
  const opaqueColor = (value) => {
    if (/^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/u.test(value)) return value;
    if (value === "rgba(0, 0, 0, 0)") return null;
    if (!limitations.includes("unsupported_color")) limitations.push("unsupported_color");
    return null;
  };
  const backgroundColor = opaqueColor(css.backgroundColor);
  if (css.backgroundColor === "rgba(0, 0, 0, 0)") limitations.push("background_transparent");
  const textColor = opaqueColor(css.color);
  const sides = ["Top", "Right", "Bottom", "Left"].filter(
    (side) =>
      Number.parseFloat(css[`border${side}Width`]) > 0 &&
      !["none", "hidden"].includes(css[`border${side}Style`]),
  );
  const borders = [...new Set(sides.map((side) => css[`border${side}Color`]))];
  const borderColor = borders.length === 1 ? opaqueColor(borders[0]) : null;
  if (borders.length > 1) limitations.push("mixed_border_colors");
  return { backgroundColor, textColor, borderColor, limitations };
};
const describe = (element, index) => ({
  id: `${frame.id}:c${index + 1}`,
  frame,
  tag: element.localName,
  role: role(element),
  text: text(element),
  label: label(element),
  placeholder: normalize(element.getAttribute("placeholder")),
  scope: [...new Set([...scope(element), ...(environment.scope ?? [])])],
  state: { ...state(element), checked: null, selected: null, selectedOptionCount: null },
  geometry: geometry(element),
  appearance: appearance(element),
  isRepeatedItem: repeatedItem(element),
});
const nodes = [];
const nodeIds = new Map();
const parentIdFor = (element) => {
  for (let ancestor = parent(element); ancestor; ancestor = parent(ancestor)) {
    checkBudget();
    if (
      nodeIds.has(ancestor) &&
      !ancestor.matches("a[href],button,input,select,textarea,summary,[role=button],[role=link]")
    )
      return nodeIds.get(ancestor);
  }
};
const frameElements = [];
const candidates = [];
let scannedCount = 0,
  eligibleCount = 0,
  excludedOffscreenCount = 0,
  unsupportedBoundaryCount = 0,
  complete = !modalityUnknown && !modalityBudgetExceeded,
  viewChanged = false;
try {
  for (const element of walkElements(document)) {
    checkBudget();
    scannedCount++;
    if (element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight)
      scrollContainers.push([
        element,
        element.scrollLeft,
        element.scrollTop,
        element.clientWidth,
        element.clientHeight,
      ]);
    if (element.matches("iframe,frame") && accessibilityExposed(element))
      frameElements.push(element);
    if (!eligible(element)) continue;
    eligibleCount++;
    if (!complete) continue;
    nodes.push(element);
  }
  if (complete) {
    await observeIntersections([
      ...nodes,
      ...frameElements,
      ...scrollContainers.map(([element]) => element),
    ]);
    complete = !modalityUnknown && !modalityBudgetExceeded;
    if (!complete) throw budgetExceeded;
    if (!viewUnchanged()) {
      viewChanged = true;
      throw budgetExceeded;
    }
    const eligibleNodes = nodes.filter((element) => element.isConnected && eligible(element));
    eligibleCount = eligibleNodes.length;
    const retained = eligibleNodes.filter(inView);
    excludedOffscreenCount = eligibleNodes.length - retained.length;
    nodes.length = 0;
    nodes.push(...retained);
    const retainedFrames = frameElements.filter(
      (element) => element.isConnected && accessibilityExposed(element) && inView(element),
    );
    frameElements.length = 0;
    frameElements.push(...retainedFrames);
    const relevantAncestors = new Set();
    for (const node of [...nodes, ...frameElements]) {
      for (
        let ancestor = parent(node);
        ancestor && !relevantAncestors.has(ancestor);
        ancestor = parent(ancestor)
      ) {
        checkBudget();
        relevantAncestors.add(ancestor);
      }
    }
    for (let index = scrollContainers.length - 1; index >= 0; index--) {
      const [element] = scrollContainers[index];
      if (!inView(element) && !relevantAncestors.has(element)) scrollContainers.splice(index, 1);
    }
    nodes.forEach((element, index) => nodeIds.set(element, `${frame.id}:c${index + 1}`));
    // Keep only sources read for serialized candidates, not offscreen eligibility checks.
    privacyDependencies.clear();
    textCache = new WeakMap();
    labelCache = new WeakMap();
    for (const element of nodes) {
      checkBudget();
      const candidate = describe(element, candidates.length);
      candidate.parentId = parentIdFor(element);
      candidates.push(candidate);
    }
  }
} catch (error) {
  if (error !== budgetExceeded) throw error;
  complete = false;
}
if (!complete) {
  nodes.length = 0;
  candidates.length = 0;
}
