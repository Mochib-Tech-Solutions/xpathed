const imageEvidence = (element, candidate = describe(element, 0)) => [
  candidate.tag,
  candidate.role,
  candidate.text,
  candidate.label,
  candidate.placeholder,
  candidate.scope,
  state(element),
  candidate.geometry,
  candidate.appearance,
  visibleRect(element),
  shadowHosts(element).map((host) => [locatorId(host), label(host)]),
];
const imageNodes = complete ? [...nodes, ...frameElements] : [];
const imageSnapshot = imageNodes.map((element, index) => imageEvidence(element, candidates[index]));
trackImageRoots = false;
const imageMembership = () => {
  const dependencies = activePrivacyDependencies,
    current = { nodes: [], frames: [] };
  activePrivacyDependencies = new Set();
  try {
    for (const element of imageRoots.keys()) {
      if (!element.isConnected) continue;
      if (eligible(element)) current.nodes.push(element);
      if (element.matches("iframe,frame") && accessibilityExposed(element))
        current.frames.push(element);
    }
    return current;
  } finally {
    activePrivacyDependencies = dependencies;
  }
};
