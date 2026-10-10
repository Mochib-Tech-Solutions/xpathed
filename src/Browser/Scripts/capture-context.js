let environment = JSON.parse(identity.environment);
const frame = JSON.parse(identity.frame);
const viewport = () => [
  innerWidth,
  innerHeight,
  scrollX,
  scrollY,
  visualViewport?.offsetLeft ?? 0,
  visualViewport?.offsetTop ?? 0,
  visualViewport?.scale ?? 1,
];
const initialViewport = viewport();
const scrollContainers = [];
const viewUnchanged = () =>
  viewport().every((value, index) => value === initialViewport[index]) &&
  scrollContainers.every(
    ([element, x, y, width, height]) =>
      element.isConnected &&
      element.scrollLeft === x &&
      element.scrollTop === y &&
      element.clientWidth === width &&
      element.clientHeight === height,
  );
const parent = (element) =>
  element.assignedSlot ?? element.parentElement ?? element.getRootNode().host ?? null;
const contains = (ancestor, element) => {
  for (let current = element; current; current = parent(current))
    if (current === ancestor) return true;
  return false;
};
let closestCache = new Map();
const privacyDependencies = new Set();
let activePrivacyDependencies = privacyDependencies;
const privacySource = (element, value) => {
  if (value) activePrivacyDependencies.add(element);
  return value;
};
const closest = (element, selector) => {
  checkBudget();
  if (!closestCache.has(selector)) closestCache.set(selector, new WeakMap());
  const cache = closestCache.get(selector),
    ancestors = [];
  let current = element;
  while (current && !cache.has(current)) {
    checkBudget();
    ancestors.push(current);
    if (current.matches(selector)) break;
    current = parent(current);
  }
  const match = current ? (cache.has(current) ? cache.get(current) : current) : undefined;
  for (const ancestor of ancestors) cache.set(ancestor, match);
  return match;
};
const activeElement = () => {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
};
function* walkElements(root) {
  const walkers = [document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)];
  while (walkers.length) {
    checkBudget();
    const walker = walkers.at(-1);
    if (!walker.nextNode()) {
      walkers.pop();
      continue;
    }
    const element = walker.currentNode;
    if (trackImageRoots && !imageRoots.has(element)) {
      imageRoots.set(element, element.shadowRoot);
      if (element.shadowRoot) imageObserver.observe(element.shadowRoot, imageObservation);
    }
    yield element;
    if (element.shadowRoot)
      walkers.push(document.createTreeWalker(element.shadowRoot, NodeFilter.SHOW_ELEMENT));
  }
}
const capturedDocument = document;
const capturedRoot = document.documentElement;
const budgetExceeded = {};
let deadline = Infinity;
const checkBudget = () => {
  if (deadline !== Infinity && performance.now() > deadline) throw budgetExceeded;
};
const imageRoots = new Map(),
  imageMaskNodes = new WeakSet();
let trackImageRoots = true,
  imageDomChanged = false;
const imageObservation = {
  subtree: true,
  childList: true,
  attributes: true,
  attributeOldValue: true,
  characterData: true,
};
const imageMutations = (records) => {
  if (imageDomChanged) return;
  imageDomChanged = records.some((record) => {
    if (imageMaskNodes.has(record.target)) return false;
    if (
      record.type === "childList" &&
      [...record.addedNodes, ...record.removedNodes].every((node) => imageMaskNodes.has(node))
    )
      return false;
    const element =
      record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
    const hiddenText =
      record.type === "characterData" ||
      (record.type === "childList" &&
        [...record.addedNodes, ...record.removedNodes].every(
          (node) => node.nodeType === Node.TEXT_NODE,
        ));
    return !(hiddenText && element?.closest("[hidden]") && !element.closest("style"));
  });
  if (imageDomChanged) imageObserver.disconnect();
};
const imageObserver = new MutationObserver(imageMutations);
imageObserver.observe(document, imageObservation);
const imageTreeUnchanged = () => {
  imageMutations(imageObserver.takeRecords());
  if (imageDomChanged) return false;
  for (const [element, root] of imageRoots) if (element.shadowRoot !== root) return false;
  return true;
};
let styleCache = new WeakMap();
let rectCache = new WeakMap();
let textCache = new WeakMap();
let labelCache = new WeakMap();
let headingCache = new WeakMap();
let exposureCache = new WeakMap();
let intersections = new WeakMap();
let siblingShapes = new WeakMap();
const clearDerivedCaches = () => {
  closestCache = new Map();
  styleCache = new WeakMap();
  rectCache = new WeakMap();
  textCache = new WeakMap();
  labelCache = new WeakMap();
  headingCache = new WeakMap();
  exposureCache = new WeakMap();
  siblingShapes = new WeakMap();
};
let modalityUnknown = false,
  modalityBudgetExceeded = false;
const currentModal = () => {
  const modals = [];
  modalityBudgetExceeded = false;
  try {
    for (const element of walkElements(document)) {
      if (element.matches("dialog:modal")) modals.push(element);
    }
    const active =
      closest(activeElement(), "dialog:modal") ??
      document.elementFromPoint(0, 0)?.closest("dialog:modal");
    modalityUnknown = modals.length > 1 && !active;
    return active ?? modals[0];
  } catch (error) {
    if (error !== budgetExceeded) throw error;
    modalityUnknown = false;
    modalityBudgetExceeded = true;
  }
};
let modal = currentModal();
