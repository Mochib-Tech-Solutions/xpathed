(() => {
  if (globalThis.__xpathedInputInstalled) return;
  globalThis.__xpathedInputInstalled = true;
  const send = globalThis.xpathedInput;
  globalThis.xpathedInput = (value) => send(String(value));
  const focus = globalThis.focus;
  globalThis.focus = function (...args) {
    const result = Reflect.apply(focus, this, args);
    if (this === globalThis) globalThis.xpathedFocus("");
    return result;
  };
  const notify = (e) => {
    if (e.isTrusted) globalThis.xpathedInput(performance.timeOrigin + performance.now());
  };
  addEventListener("pointerdown", notify, true);
  addEventListener("keydown", notify, true);
  const cursor = (event) => {
    if (!event.isTrusted) return;
    const element = event.composedPath().find((node) => node instanceof Element);
    if (!element) return;
    // Use the CSS fallback instead of loading cursor images from the remote page.
    let value = getComputedStyle(element).cursor.split(",").at(-1).trim();
    if (value === "auto") {
      value =
        element instanceof HTMLTextAreaElement ||
        element.isContentEditable ||
        (element instanceof HTMLInputElement &&
          !element.disabled &&
          ["text", "search", "email", "password", "url", "tel", "number"].includes(element.type))
          ? "text"
          : "default";
    }
    globalThis.xpathedCursor(value);
  };
  addEventListener("pointermove", cursor, true);
  addEventListener("pointerover", cursor, true);
  addEventListener("focus", () => {
    if (document.hasFocus()) globalThis.xpathedFocus("");
  });
})();
