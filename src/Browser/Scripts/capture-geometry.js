const geometry = (element) => {
  const { x, y, width, height } = rectFor(element);
  return {
    x: environment.x + x * environment.scaleX,
    y: environment.y + y * environment.scaleY,
    width: width * environment.scaleX,
    height: height * environment.scaleY,
  };
};
const intersection = (a, b) => ({
  left: Math.max(a.left, b.left),
  top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom),
});
const observeIntersections = async (elements) => {
  const pending = new Set(elements);
  intersections = new WeakMap();
  if (!pending.size) return;
  checkBudget();
  let observer, timeout;
  try {
    await new Promise((resolve, reject) => {
      if (Number.isFinite(deadline))
        timeout = setTimeout(
          () => reject(budgetExceeded),
          Math.max(0, deadline - performance.now()),
        );
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const { x, y, width, height } = entry.intersectionRect;
            intersections.set(entry.target, { x, y, width, height });
            pending.delete(entry.target);
          }
          if (!pending.size) resolve();
        },
        { root: document },
      );
      for (const element of pending) observer.observe(element);
    });
    checkBudget();
  } finally {
    clearTimeout(timeout);
    observer?.disconnect();
    // Page scripts can mutate ancestry or privacy attributes while observation awaits a rendering update.
    clearDerivedCaches();
    privacyDependencies.clear();
    modal = currentModal();
  }
};
const visibleRect = (element) => {
  const rect = intersections.get(element);
  if (!rect || rect.width <= 0 || rect.height <= 0) return { left: 0, top: 0, right: 0, bottom: 0 };
  // Keep the target's own legacy CSS clip in its observed geometry.
  const css = cssFor(element),
    clip = css.clip.match(/^rect\(([^)]+)\)$/);
  if (clip && ["absolute", "fixed"].includes(css.position)) {
    const [top, right, bottom, left] = clip[1].split(/[,\s]+/u).map(Number.parseFloat);
    if (right <= left || bottom <= top) return { left: 0, top: 0, right: 0, bottom: 0 };
  }
  return intersection(environment.clip, {
    left: environment.x + rect.x * environment.scaleX,
    top: environment.y + rect.y * environment.scaleY,
    right: environment.x + (rect.x + rect.width) * environment.scaleX,
    bottom: environment.y + (rect.y + rect.height) * environment.scaleY,
  });
};
const pointFor = (element) => {
  const clip = visibleRect(element);
  return { x: (clip.left + clip.right) / 2, y: (clip.top + clip.bottom) / 2 };
};
const inView = (element) => {
  const rect = visibleRect(element);
  return rect.right > rect.left && rect.bottom > rect.top;
};
const receivesPoint = (element, point) => {
  let hit = document.elementFromPoint(
    (point.x - environment.x) / environment.scaleX,
    (point.y - environment.y) / environment.scaleY,
  );
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(
      (point.x - environment.x) / environment.scaleX,
      (point.y - environment.y) / environment.scaleY,
    );
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return !!hit && contains(element, hit);
};
const reset = (budgetMs = Infinity) => {
  deadline = performance.now() + budgetMs;
  clearDerivedCaches();
  modal = currentModal();
};
const state = (element) => {
  const rect = visibleRect(element);
  return {
    accessibilityExposed: accessibilityExposed(element),
    readonly:
      ((element.localName === "textarea" ||
        (element.localName === "input" &&
          [
            "text",
            "search",
            "email",
            "url",
            "tel",
            "password",
            "number",
            "date",
            "month",
            "week",
            "time",
            "datetime-local",
          ].includes(element.type))) &&
        element.readOnly) ||
      (["textbox", "searchbox", "spinbutton", "combobox", "listbox", "checkbox", "slider"].includes(
        role(element),
      ) &&
        element.getAttribute("aria-readonly") === "true"),
    rendered: rendered(element),
    inViewport: rect.right > rect.left && rect.bottom > rect.top,
    enabled:
      environment.enabled !== false &&
      !element.matches(":disabled") &&
      !closest(element, '[aria-disabled="true"]'),
    editable:
      fillControl(element) && !element.readOnly && element.getAttribute("aria-readonly") !== "true",
    selected: { true: true, false: false }[element.getAttribute("aria-selected")] ?? null,
    selectedOptionCount: element.localName === "select" ? element.selectedOptions.length : null,
    checked: element.matches("input[type=checkbox],input[type=radio]")
      ? element.checked
      : ({ true: true, false: false }[element.getAttribute("aria-checked")] ?? null),
  };
};
