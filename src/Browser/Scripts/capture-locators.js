const locatorNodes = new Map(),
  locatorNodeIds = new WeakMap(),
  verifiedXpaths = new Map();
let xpathPrivacyDependencies = null,
  xpathPrivacyTargets = null;
const locatorId = (element) => {
  if (!locatorNodeIds.has(element)) {
    const id = `${frame.id}:n${locatorNodes.size + 1}`;
    locatorNodeIds.set(element, id);
    locatorNodes.set(id, element);
  }
  return locatorNodeIds.get(element);
};
const evaluate = (xpath, root) =>
  document.evaluate(
    xpath,
    root === document ? document : root.firstElementChild,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );
const uniqueMatch = (xpath, element) => {
  checkBudget();
  if (!element?.isConnected || element.ownerDocument !== capturedDocument) return false;
  try {
    const matches = evaluate(xpath, element.getRootNode());
    return matches.snapshotLength === 1 && matches.snapshotItem(0) === element;
  } catch (error) {
    if (error instanceof DOMException) return false;
    throw error;
  }
};
const shadowHosts = (element) => {
  const hosts = [];
  for (let root = element.getRootNode(); root.host; root = root.host.getRootNode()) {
    checkBudget();
    hosts.unshift(root.host);
  }
  return hosts;
};
const shadowChain = (element) => {
  const hosts = shadowHosts(element);
  return hosts.length
    ? hosts.map((host) => ({
        nodeId: locatorId(host),
        xpath: verifiedXpaths.get(locatorId(host)) ?? "",
        label: label(host),
      }))
    : undefined;
};
const resolvedShadowChain = (chain) =>
  chain?.map((step) => ({ ...step, xpath: verifiedXpaths.get(step.nodeId) ?? "" }));
const validShadowChain = (element, chain) => {
  let root = document;
  for (const step of chain ?? []) {
    checkBudget();
    const host = locatorNodes.get(step.nodeId),
      xpath = verifiedXpaths.get(step.nodeId);
    if (!host?.shadowRoot || host.getRootNode() !== root || !xpath || !uniqueMatch(xpath, host))
      return false;
    root = host.shadowRoot;
  }
  return root === element.getRootNode();
};
