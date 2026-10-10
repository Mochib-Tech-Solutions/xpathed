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
  addEventListener("focus", () => {
    if (document.hasFocus()) globalThis.xpathedFocus("");
  });
})();
