async (identity) => {
  /* include:capture-context */
  /* include:capture-semantics */
  /* include:capture-geometry */
  /* include:capture-readiness */
  /* include:capture-candidates */
  /* include:capture-locators */
  /* include:capture-xpath */
  /* include:capture-images */
  return {
    frameElements,
    xpathEvidence,
    verifyXpathProposals,
    dispose() {
      imageObserver.disconnect();
    },
    imageMaskNode(node) {
      imageMaskNodes.add(node);
    },
    imageMaskStyle(element, update) {
      imageMutations(imageObserver.takeRecords());
      const previous = element.getAttribute("style");
      update();
      let skipped = false;
      imageMutations(
        imageObserver.takeRecords().filter((record) => {
          if (
            !skipped &&
            record.type === "attributes" &&
            record.target === element &&
            record.attributeName === "style" &&
            record.oldValue === previous
          ) {
            skipped = true;
            return false;
          }
          return true;
        }),
      );
    },
    async imageUnchanged(value) {
      if (
        !complete ||
        !imageTreeUnchanged() ||
        capturedDocument !== document ||
        capturedRoot !== document.documentElement ||
        !viewUnchanged() ||
        imageNodes.some(
          (element) => !element.isConnected || element.ownerDocument !== capturedDocument,
        )
      )
        return false;
      environment = value
        ? JSON.parse(value)
        : {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            exposed: true,
            rendered: true,
            clip: { left: 0, top: 0, right: innerWidth, bottom: innerHeight },
          };
      reset();
      const dependencies = [...privacyDependencies];
      const membership = imageMembership(),
        observed = new Set([...membership.nodes, ...membership.frames]);
      try {
        await observeIntersections(observed);
      } finally {
        for (const source of dependencies) privacyDependencies.add(source);
      }
      const current = imageMembership();
      if ([...current.nodes, ...current.frames].some((element) => !observed.has(element)))
        return false;
      const currentNodes = current.nodes.filter(inView),
        currentFrames = current.frames.filter(inView);
      if (
        currentNodes.length !== nodes.length ||
        currentNodes.some((element) => !nodeIds.has(element)) ||
        currentFrames.length !== frameElements.length ||
        currentFrames.some((element) => !frameElements.includes(element))
      )
        return false;
      // Eligibility reads are not serialized evidence; collect the retained names' actual sources again.
      textCache = new WeakMap();
      labelCache = new WeakMap();
      return (
        !modalityUnknown &&
        !modalityBudgetExceeded &&
        imageTreeUnchanged() &&
        viewUnchanged() &&
        imageNodes.every(
          (element, index) =>
            element.isConnected &&
            element.ownerDocument === capturedDocument &&
            accessibilityExposed(element) &&
            JSON.stringify(imageEvidence(element)) === JSON.stringify(imageSnapshot[index]),
        )
      );
    },
    xpathPrivacyUnchanged() {
      deadline = Infinity;
      closestCache = new Map();
      return (
        xpathPrivacyTargets !== null &&
        xpathPrivacyDependencies !== null &&
        [...xpathPrivacyTargets].every(
          (element) => element.isConnected && element.ownerDocument === capturedDocument,
        ) &&
        [...xpathPrivacyTargets, ...xpathPrivacyDependencies].every(
          (element) => !closest(element, "[data-private],[data-sensitive]"),
        )
      );
    },
    privacyUnchanged() {
      deadline = Infinity;
      closestCache = new Map();
      return (
        frameElements.every(
          (element) => element.isConnected && element.ownerDocument === capturedDocument,
        ) &&
        [...nodes, ...frameElements, ...privacyDependencies].every(
          (element) => !closest(element, "[data-private],[data-sensitive]"),
        )
      );
    },
    highlightNodes(ids) {
      return ids.map((id) => {
        const node = nodes[candidates.findIndex((candidate) => candidate.id === id)];
        if (!node?.isConnected || node.ownerDocument !== document) throw new Error("stale_capture");
        return node;
      });
    },
    async updateEnvironment(value, budgetMs, candidateIds) {
      try {
        environment = value
          ? JSON.parse(value)
          : {
              x: 0,
              y: 0,
              scaleX: 1,
              scaleY: 1,
              exposed: true,
              rendered: true,
              clip: { left: 0, top: 0, right: innerWidth, bottom: innerHeight },
            };
        reset(budgetMs);
        const selected = candidateIds
          .map((id) => nodes[candidates.findIndex((candidate) => candidate.id === id)])
          .filter(Boolean);
        await observeIntersections(
          [...selected, ...frameElements].filter((element) => element.isConnected),
        );
        return {};
      } catch (error) {
        if (error === budgetExceeded) return { errorCode: "validation_budget_exceeded" };
        throw error;
      }
    },
    receivesPoint(element, point, budgetMs) {
      reset(budgetMs);
      return receivesPoint(element, point);
    },
    point(candidateId, budgetMs) {
      try {
        reset(budgetMs);
        return pointFor(nodes[candidates.findIndex((candidate) => candidate.id === candidateId)]);
      } catch (error) {
        if (error === budgetExceeded) return { errorCode: "validation_budget_exceeded" };
        throw error;
      }
    },
    frameInfo(element, budgetMs) {
      try {
        reset(budgetMs);
        if (
          !element.isConnected ||
          element.ownerDocument !== document ||
          !frameElements.includes(element)
        )
          throw new Error("stale_frame");
        const verified = verifiedXpaths.get(locatorId(element));
        if (
          verified &&
          (!uniqueMatch(verified, element) || !validShadowChain(element, shadowChain(element)))
        )
          return { errorCode: "stale_capture" };
        const rect = geometry(element);
        const scaleX = element.offsetWidth ? rect.width / element.offsetWidth : environment.scaleX;
        const scaleY = element.offsetHeight
          ? rect.height / element.offsetHeight
          : environment.scaleY;
        let geometrySupported = true;
        for (let current = element; current; current = parent(current)) {
          checkBudget();
          const css = cssFor(current);
          const individualScale = css.scale === "none" ? [] : css.scale.split(/\s+/u).map(Number);
          const matrix = css.transform === "none" ? null : new DOMMatrixReadOnly(css.transform);
          if (
            (matrix &&
              (!matrix.is2D ||
                matrix.b !== 0 ||
                matrix.c !== 0 ||
                matrix.a <= 0 ||
                matrix.d <= 0)) ||
            css.perspective !== "none" ||
            css.rotate !== "none" ||
            individualScale.some((value) => !Number.isFinite(value) || value <= 0)
          )
            geometrySupported = false;
        }
        return {
          nodeId: locatorId(element),
          xpath: verifiedXpaths.get(locatorId(element)) ?? "",
          shadowChain: shadowChain(element),
          label: label(element),
          environment: {
            scope: [...new Set([...scope(element), ...(environment.scope ?? [])])],
            x: rect.x + element.clientLeft * scaleX,
            y: rect.y + element.clientTop * scaleY,
            scaleX: scaleX || 1,
            scaleY: scaleY || 1,
            clip: intersection(visibleRect(element), {
              left: rect.x + element.clientLeft * scaleX,
              top: rect.y + element.clientTop * scaleY,
              right: rect.x + (element.clientLeft + element.clientWidth) * scaleX,
              bottom: rect.y + (element.clientTop + element.clientHeight) * scaleY,
            }),
            exposed: accessibilityExposed(element),
            rendered: rendered(element),
            enabled: state(element).enabled,
            geometrySupported,
            complexEffects: complexEffects(element),
          },
        };
      } catch (error) {
        if (error === budgetExceeded) return { errorCode: "validation_budget_exceeded" };
        throw error;
      }
    },
    data: {
      sessionId: identity.sessionId,
      pageId: identity.pageId,
      documentId: identity.documentId,
      captureId: identity.captureId,
      frameId: frame.id,
      capturedAt: new Date().toISOString(),
      candidates,
      scope: identity.scope,
      coverage: {
        scannedCount,
        eligibleCount,
        excludedOffscreenCount,
        capturedCount: candidates.length,
        complete,
        errorCode: complete
          ? null
          : viewChanged
            ? "capture_view_changed"
            : modalityUnknown
              ? "capture_exposure_unknown"
              : "capture_incomplete",
      },
      unsupportedBoundaryCount,
    },
    select(candidateId, action, budgetMs = 2000) {
      try {
        reset(budgetMs);
        if (modalityUnknown) return { errorCode: "capture_exposure_unknown" };
        if (capturedDocument !== document) return { errorCode: "stale_document" };
        if (!complete) return { errorCode: "capture_incomplete" };
        if (document.documentElement !== capturedRoot) return { errorCode: "stale_capture" };
        if (candidateId === null) return { target: null };
        const index = candidates.findIndex((candidate) => candidate.id === candidateId);
        if (index < 0) return { errorCode: "unknown_candidate" };
        const element = nodes[index];
        if (
          !element.isConnected ||
          element.ownerDocument !== capturedDocument ||
          !accessibilityExposed(element)
        )
          return { errorCode: "stale_capture" };
        if (!inView(element) || !validShadowChain(element, candidates[index].shadowChain))
          return { errorCode: "stale_capture" };
        const captured = candidates[index];
        if (
          label(element) !== captured.label ||
          text(element) !== captured.text ||
          role(element) !== captured.role
        )
          return { errorCode: "stale_capture" };
        const xpath = verifiedXpaths.get(locatorId(element));
        if (!xpath || !uniqueMatch(xpath, element)) return { errorCode: "xpath_validation_failed" };
        const xpaths = [xpath];
        return {
          target: {
            candidateId,
            frame,
            shadowChain: resolvedShadowChain(candidates[index].shadowChain),
            tag: element.localName,
            role: role(element),
            accessibleName: label(element),
            label: candidates[index].label || candidates[index].text,
            xpaths,
            state: state(element),
            geometry: geometry(element),
            interactability: interactability(element, action),
          },
        };
      } catch (error) {
        if (error === budgetExceeded) return { errorCode: "validation_budget_exceeded" };
        throw error;
      }
    },
  };
};
