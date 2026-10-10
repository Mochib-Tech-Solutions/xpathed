async (capture) => {
  const selector =
    "input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=combobox],[data-private],[data-sensitive]";
  const roots = [],
    controls = [],
    styles = [],
    masks = [],
    previousOpacity = [];
  const updateStyle = (element, update) =>
    capture ? capture.imageMaskStyle(element, update) : update();
  const collect = (root, inheritedPrivate = false) => {
    roots.push(root);
    for (const element of root.querySelectorAll("*")) {
      const privateElement =
        inheritedPrivate || element.matches(selector) || !!element.closest(selector);
      if (privateElement) controls.push(element);
      if (element.shadowRoot) collect(element.shadowRoot, privateElement);
    }
  };
  collect(document);
  if (controls.some((element) => getComputedStyle(element).display === "contents"))
    throw new Error("Private subtree cannot be safely masked");
  const boxes = controls.map((element) => {
    const rect = element.getBoundingClientRect();
    return [rect.x, rect.y, rect.width, rect.height];
  });
  const maskBoxes = controls
    .filter((element) => {
      if (!element.matches(selector)) return false;
      for (
        let ancestor = element.parentElement ?? element.getRootNode().host;
        ancestor;
        ancestor = ancestor.parentElement ?? ancestor.getRootNode().host
      ) {
        if (ancestor.matches(selector)) return false;
      }
      return true;
    })
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height];
    });
  for (const element of controls) {
    previousOpacity.push([
      element.style.getPropertyValue("opacity"),
      element.style.getPropertyPriority("opacity"),
    ]);
    updateStyle(element, () => element.style.setProperty("opacity", "0", "important"));
  }
  for (const root of roots) {
    const style = document.createElement("style");
    capture?.imageMaskNode(style);
    style.textContent = `:is(${selector}), :is(${selector}) * { opacity: 0 !important; color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; transition: none !important; } * { caret-color: transparent !important; }`;
    (root === document ? document.documentElement : root).append(style);
    styles.push(style);
  }
  for (const [x, y, width, height] of maskBoxes) {
    if (width <= 0 || height <= 0) continue;
    const mask = document.createElement("div");
    capture?.imageMaskNode(mask);
    // LCD text filtering can leave a raster fringe outside the element's layout bounds.
    const left = Math.floor(x) - 1,
      top = Math.floor(y) - 1;
    const right = Math.ceil(x + width) + 1,
      bottom = Math.ceil(y + height) + 1;
    mask.style.cssText = `all: initial !important; position: fixed !important; left:${left}px !important; top:${top}px !important; width:${right - left}px !important; height:${bottom - top}px !important; background:rgb(119,119,119) !important; opacity:1 !important; z-index:2147483647 !important; pointer-events:none !important;`;
    document.documentElement.append(mask);
    masks.push(mask);
  }
  await document.fonts.ready;
  return {
    unchanged: () => {
      const fresh = [],
        freshRoots = [];
      const visit = (root, inheritedPrivate = false) => {
        freshRoots.push(root);
        for (const element of root.querySelectorAll("*")) {
          if (styles.includes(element) || masks.includes(element)) continue;
          const privateElement =
            inheritedPrivate || element.matches(selector) || !!element.closest(selector);
          if (privateElement) fresh.push(element);
          if (element.shadowRoot) visit(element.shadowRoot, privateElement);
        }
      };
      visit(document);
      return (
        roots.length === freshRoots.length &&
        roots.every((root, index) => root === freshRoots[index]) &&
        controls.length === fresh.length &&
        controls.every((element, index) => {
          const rect = element.getBoundingClientRect();
          return (
            element === fresh[index] &&
            getComputedStyle(element).opacity === "0" &&
            [rect.x, rect.y, rect.width, rect.height].every(
              (value, part) => value === boxes[index][part],
            )
          );
        }) &&
        styles.every((style) => style.isConnected) &&
        masks.every((mask) => mask.isConnected)
      );
    },
    clear: () => {
      for (let index = 0; index < controls.length; index++) {
        const [value, priority] = previousOpacity[index];
        updateStyle(controls[index], () => {
          if (value) controls[index].style.setProperty("opacity", value, priority);
          else controls[index].style.removeProperty("opacity");
        });
      }
      for (const element of [...styles, ...masks]) element.remove();
    },
  };
};
