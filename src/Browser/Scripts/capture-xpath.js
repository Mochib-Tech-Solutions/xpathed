const xpathEvidence = (candidateIds, requestedNodeIds, budgetMs = 2000) => {
  const dependencies = new Set(),
    retainedTargets = new Set();
  xpathPrivacyDependencies = null;
  xpathPrivacyTargets = null;
  activePrivacyDependencies = dependencies;
  try {
    reset(budgetMs);
    if (!complete || document.documentElement !== capturedRoot)
      return { errorCode: "stale_capture" };
    const records = new Map(),
      targets = new Set(),
      selectedTargets = [],
      queue = [],
      describedText = new Set(),
      describedContext = new Set();
    const schedule = (element, withText = false, withContext = false) => {
      const id = locatorId(element);
      queue.push([element, withText, withContext]);
      return id;
    };
    const target = (element) => {
      if (
        !element?.isConnected ||
        element.ownerDocument !== capturedDocument ||
        !accessibilityExposed(element)
      )
        throw new Error("stale_capture");
      retainedTargets.add(element);
      const id = locatorId(element);
      if (!targets.has(id)) {
        targets.add(id);
        schedule(element, true, true);
      }
    };
    for (const candidateId of candidateIds) {
      const index = candidates.findIndex((candidate) => candidate.id === candidateId),
        element = nodes[index],
        captured = candidates[index];
      target(element);
      if (
        label(element) !== captured.label ||
        text(element) !== captured.text ||
        role(element) !== captured.role
      )
        return { errorCode: "stale_capture" };
      selectedTargets.push({
        candidateId,
        nodeId: locatorId(element),
        frame,
        shadowChain: captured.shadowChain ?? null,
      });
    }
    for (const id of requestedNodeIds) target(locatorNodes.get(id));
    let position = 0;
    while (position < queue.length) {
      checkBudget();
      const [element, withText, withContext] = queue[position++],
        id = locatorId(element);
      if (!records.has(id)) {
        const siblings = [
          ...(element.parentElement?.children ?? element.getRootNode().children),
        ].filter(
          (sibling) =>
            sibling.localName === element.localName &&
            sibling.namespaceURI === element.namespaceURI,
        );
        const attributes = {};
        if (!closest(element, ignored)) {
          for (const name of [
            "id",
            "name",
            "aria-label",
            "placeholder",
            "alt",
            "title",
            "type",
            "for",
            "role",
            "data-testid",
            "data-test-id",
            "data-test",
            "data-cy",
            "data-qa",
          ]) {
            const value = element.getAttribute(name);
            if (value !== null) attributes[name] = privacySource(element, value);
          }
          if (element.matches(buttonInput) && element.hasAttribute("value"))
            attributes.value = privacySource(element, element.getAttribute("value"));
        }
        const hosts = shadowHosts(element);
        for (const host of hosts) target(host);
        records.set(id, {
          nodeId: id,
          candidateId: nodeIds.get(element) ?? null,
          tag: element.localName,
          namespaceUri: element.namespaceURI ?? "",
          attributes,
          text: "",
          textFragments: [],
          textNodeCount: 0,
          maximumTextLength: 0,
          excludedText: false,
          parentId: element.parentElement ? schedule(element.parentElement) : null,
          siblingIndex: siblings.indexOf(element) + 1,
          siblingCount: siblings.length,
          headingId: null,
          cellIds: [],
          labelIds: [],
          shadowHostIds: hosts.map(locatorId),
        });
      }
      const record = records.get(id);
      if (withText && !describedText.has(id)) {
        describedText.add(id);
        record.text = text(element);
        if (record.text) {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            checkBudget();
            const value = node.textContent,
              nonempty = value.replace(/[ \t\r\n]+/gu, " ").replace(/^ | $/gu, "");
            record.maximumTextLength = Math.max(record.maximumTextLength, value.length);
            if (nonempty) record.textNodeCount++;
            if (
              closest(node.parentElement, valueContainer + "," + ignored) ||
              !accessibilityExposed(node.parentElement)
            ) {
              record.excludedText = true;
              continue;
            }
            record.textFragments.push({
              index: record.textNodeCount,
              text: privacySource(node.parentElement, value),
            });
          }
        }
      }
      if (withContext && !describedContext.has(id)) {
        describedContext.add(id);
        if (element.parentElement) schedule(element.parentElement, false, true);
        const heading = headingFor(element);
        if (heading) record.headingId = schedule(heading, true);
        if (element.matches("tr,[role=row]"))
          record.cellIds = [...element.children]
            .filter(
              (cell) =>
                cell.matches("td,th,[role=cell],[role=rowheader],[role=gridcell]") &&
                !closest(cell, ignored),
            )
            .map((cell) => schedule(cell, true));
        record.labelIds = [...(element.labels ?? [])]
          .filter((reference) => !closest(reference, ignored))
          .map((reference) => schedule(reference, true));
      }
    }
    xpathPrivacyDependencies = dependencies;
    xpathPrivacyTargets = retainedTargets;
    return {
      nodes: [...records.values()],
      targetNodeIds: [...targets],
      targets: selectedTargets,
    };
  } catch (error) {
    if (error === budgetExceeded) return { errorCode: "validation_budget_exceeded" };
    if (error.message === "stale_capture") return { errorCode: "stale_capture" };
    throw error;
  } finally {
    activePrivacyDependencies = privacyDependencies;
  }
};
const verifyXpathProposals = (sets, budgetMs = 2000) => {
  try {
    reset(budgetMs);
    const accepted = new Map(),
      matches = new Map();
    const match = (expression, nodeId) => {
      const key = nodeId + "\0" + expression;
      if (!matches.has(key)) matches.set(key, uniqueMatch(expression, locatorNodes.get(nodeId)));
      return matches.get(key);
    };
    for (const set of sets) {
      checkBudget();
      const element = locatorNodes.get(set.nodeId);
      if (!element?.isConnected || !accessibilityExposed(element))
        return { errorCode: "stale_capture" };
      const proposal = set.proposals.find(
        (proposal) =>
          proposal.requirements.every((requirement) =>
            match(requirement.expression, requirement.nodeId),
          ) && match(proposal.expression, set.nodeId),
      );
      if (!proposal) return { errorCode: "xpath_validation_failed" };
      accepted.set(set.nodeId, proposal.expression);
    }
    for (const [id, xpath] of accepted) verifiedXpaths.set(id, xpath);
    return {};
  } catch (error) {
    if (error === budgetExceeded) return { errorCode: "validation_budget_exceeded" };
    throw error;
  }
};
try {
  if (complete)
    for (let index = 0; index < nodes.length; index++) {
      const chain = shadowChain(nodes[index]);
      if (chain) candidates[index].shadowChain = chain;
    }
} catch (error) {
  if (error !== budgetExceeded) throw error;
  complete = false;
  candidates.length = 0;
}
