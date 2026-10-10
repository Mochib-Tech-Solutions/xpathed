import type { Frame } from "./viewerProtocol";

function modifiers(event: MouseEvent | KeyboardEvent) {
  return +event.altKey | (+event.ctrlKey << 1) | (+event.metaKey << 2) | (+event.shiftKey << 3);
}

function browserShortcut(event: KeyboardEvent) {
  const key = event.key.toLowerCase();
  const control = event.ctrlKey || event.metaKey;
  return (
    key === "f11" ||
    key === "f12" ||
    (control &&
      (["t", "n", "w", "l", "tab", "pageup", "pagedown"].includes(key) || /^[1-9]$/.test(key))) ||
    (control && event.shiftKey && ["i", "j", "c"].includes(key)) ||
    (event.altKey && (key === "d" || key === "f4"))
  );
}

export default function bindViewerInput(
  container: HTMLDivElement,
  surface: HTMLCanvasElement,
  input: HTMLTextAreaElement,
  state: { frame?: Frame },
  send: (message: object) => void,
  command: (message: object) => void,
) {
  let composing = false;
  let compositionFrame: Frame | undefined;
  const heldKeys = new Map<string, KeyboardEvent>();
  const heldPointers = new Map<
    number,
    {
      x: number;
      y: number;
      button: string;
      clickCount: number;
      pageId: string;
      documentId: string;
    }
  >();
  let lastPress: { time: number; x: number; y: number; button: number; count: number } | undefined;
  const key = (event: KeyboardEvent, direction: "down" | "up", value?: string) => {
    command({
      type: "key",
      event: direction,
      key: event.key,
      code: event.code,
      modifiers: modifiers(event),
      ...(value !== undefined ? { text: value } : {}),
      ...(direction === "down" && event.repeat ? { repeat: true } : {}),
    });
  };
  const releaseKeys = () => {
    heldKeys.forEach((event) =>
      command({ type: "key", event: "up", key: event.key, code: event.code, modifiers: 0 }),
    );
    heldKeys.clear();
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "F8" || browserShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "F8") {
        releaseKeys();
        container.focus();
      }
      return;
    }
    if (event.target === container) {
      if (event.key === "Enter") {
        event.preventDefault();
        input.focus({ preventScroll: true });
      }
      return;
    }
    if (composing || event.isComposing || event.key === "Dead" || event.key === "Process") return;
    // The local paste event supplies Unicode once; remote clipboard state is unrelated.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
    const printable =
      Array.from(event.key).length === 1 &&
      (!(event.ctrlKey || event.metaKey) || event.getModifierState("AltGraph"));
    key(event, "down", printable ? event.key : undefined);
    heldKeys.set(event.code, event);
    // Native key text preserves the page's keydown cancellation; IME and paste use insertText.
    event.preventDefault();
  };
  const keyup = (event: KeyboardEvent) => {
    if (heldKeys.delete(event.code)) key(event, "up");
  };
  const text = () => {
    if (composing || !input.value) return;
    command({ type: "text", text: input.value });
    input.value = "";
  };
  const compositionStart = () => {
    composing = true;
    compositionFrame = state.frame;
  };
  const compositionEnd = () => {
    composing = false;
    if (
      !compositionFrame ||
      compositionFrame.pageId !== state.frame?.pageId ||
      compositionFrame.documentId !== state.frame.documentId
    ) {
      input.value = "";
      return;
    }
    text();
  };
  const paste = (event: ClipboardEvent) => {
    event.preventDefault();
    const value = event.clipboardData?.getData("text/plain");
    if (value) command({ type: "text", text: value });
  };
  const pointer = (
    event: MouseEvent | WheelEvent,
    kind: "move" | "down" | "up" | "wheel",
    clickCount?: number,
    releasedButton?: string,
  ) => {
    if (!state.frame) return;
    event.preventDefault();
    if (kind === "down") input.focus({ preventScroll: true });
    const bounds = surface.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const scaleX = state.frame.width / bounds.width;
    const scaleY = state.frame.height / bounds.height;
    const wheelScale =
      "deltaMode" in event
        ? event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? state.frame.height
            : 1
        : 1;
    const point = {
      x: Math.max(0, Math.min(state.frame.width - 1, (event.clientX - bounds.left) * scaleX)),
      y: Math.max(0, Math.min(state.frame.height - 1, (event.clientY - bounds.top) * scaleY)),
      button:
        releasedButton ??
        (kind === "wheel" || (kind === "move" && !event.buttons)
          ? "none"
          : (["left", "middle", "right"][event.button] ?? "none")),
    };
    command({
      type: "mouse",
      event: kind,
      ...point,
      buttons: event.buttons,
      modifiers: modifiers(event),
      ...(clickCount !== undefined ? { clickCount } : {}),
      ...("deltaX" in event
        ? { deltaX: event.deltaX * wheelScale, deltaY: event.deltaY * wheelScale }
        : {}),
    });
    return point;
  };
  const down = (event: PointerEvent) => {
    if (!state.frame) return;
    surface.setPointerCapture(event.pointerId);
    const clickCount =
      lastPress &&
      event.timeStamp - lastPress.time <= 500 &&
      event.button === lastPress.button &&
      Math.hypot(event.clientX - lastPress.x, event.clientY - lastPress.y) <= 4
        ? Math.min(lastPress.count + 1, 3)
        : 1;
    const point = pointer(event, "down", clickCount);
    if (!point) return;
    heldPointers.set(event.pointerId, {
      ...point,
      clickCount,
      pageId: state.frame.pageId,
      documentId: state.frame.documentId,
    });
    lastPress = {
      time: event.timeStamp,
      x: event.clientX,
      y: event.clientY,
      button: event.button,
      count: clickCount,
    };
  };
  const up = (event: PointerEvent) => {
    const held = heldPointers.get(event.pointerId);
    if (!held) return;
    heldPointers.delete(event.pointerId);
    pointer(event, "up", held.clickCount, held.button);
  };
  const cancel = (event: PointerEvent) => {
    const held = heldPointers.get(event.pointerId);
    if (!held) return;
    heldPointers.delete(event.pointerId);
    send({ type: "mouse", event: "up", ...held, clickCount: 0, buttons: 0, modifiers: 0 });
    lastPress = undefined;
  };
  const releaseInput = () => {
    releaseKeys();
    heldPointers.forEach((held) =>
      send({ type: "mouse", event: "up", ...held, clickCount: 0, buttons: 0, modifiers: 0 }),
    );
    lastPress = undefined;
    heldPointers.clear();
  };
  const move = (event: PointerEvent) => {
    const point = pointer(event, "move");
    const held = heldPointers.get(event.pointerId);
    if (held && point) heldPointers.set(event.pointerId, { ...held, x: point.x, y: point.y });
  };
  const wheel = (event: WheelEvent) => pointer(event, "wheel");
  const contextMenu = (event: Event) => event.preventDefault();
  container.addEventListener("keydown", keydown);
  container.addEventListener("keyup", keyup);
  input.addEventListener("blur", releaseKeys);
  input.addEventListener("input", text);
  input.addEventListener("compositionstart", compositionStart);
  input.addEventListener("compositionend", compositionEnd);
  input.addEventListener("paste", paste);
  surface.addEventListener("pointerdown", down);
  surface.addEventListener("pointerup", up);
  surface.addEventListener("pointercancel", cancel);
  surface.addEventListener("lostpointercapture", cancel);
  window.addEventListener("blur", releaseInput);
  surface.addEventListener("pointermove", move);
  surface.addEventListener("wheel", wheel, { passive: false });
  surface.addEventListener("contextmenu", contextMenu);
  return {
    reset() {
      heldKeys.clear();
      heldPointers.clear();
      lastPress = undefined;
      input.value = "";
    },
    clearHeld() {
      heldKeys.clear();
      heldPointers.clear();
    },
    release: releaseInput,
    dispose() {
      container.removeEventListener("keydown", keydown);
      container.removeEventListener("keyup", keyup);
      input.removeEventListener("blur", releaseKeys);
      input.removeEventListener("input", text);
      input.removeEventListener("compositionstart", compositionStart);
      input.removeEventListener("compositionend", compositionEnd);
      input.removeEventListener("paste", paste);
      surface.removeEventListener("pointerdown", down);
      surface.removeEventListener("pointerup", up);
      surface.removeEventListener("pointercancel", cancel);
      surface.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("blur", releaseInput);
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("wheel", wheel);
      surface.removeEventListener("contextmenu", contextMenu);
    },
  };
}
