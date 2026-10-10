import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { Session } from "./api";

type ViewerStatus = "Connecting" | "Connected" | "Disconnected";
type Frame = {
  type: "frame";
  frameId: number;
  pageId: string;
  documentId: string;
  width: number;
  height: number;
  data: string;
};
type PageDialog = {
  type: "dialog";
  pageId: string;
  documentId: string;
  dialogId: string;
  dialogType: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt: string;
};
type PageSelect = {
  type: "select";
  pageId: string;
  documentId: string;
  pickerId: string;
  options: { id: string; label: string; disabled: boolean; selected: boolean }[];
};
type SelectState = PageSelect & {
  pending: boolean;
  answer: (optionId: string | null) => void;
};
type DialogState = PageDialog & {
  pending: boolean;
  answer: (accept: boolean, promptText?: string) => void;
};

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

export default function BrowserViewer({ session }: { session: Session }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const keyboardInput = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState<ViewerStatus>("Connecting");
  const [connection, setConnection] = useState(0);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [picker, setPicker] = useState<SelectState | null>(null);
  const optionInput = useRef<HTMLSelectElement>(null);
  const promptInput = useRef<HTMLInputElement>(null);
  const cancelDialog = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const container = host.current;
    const surface = canvas.current;
    const input = keyboardInput.current;
    if (!container || !surface || !input) return;
    let active = true;
    let ended = false;
    let controlSequence = 0;
    let frame: Frame | undefined;
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
    let lastPress:
      { time: number; x: number; y: number; button: number; count: number } | undefined;
    const url = new URL(session.viewPath, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    const send = (message: object) => {
      if (active && !ended && socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
    };
    const command = (message: object) => {
      if (frame) send({ ...message, pageId: frame.pageId, documentId: frame.documentId });
    };
    socket.onmessage = ({ data }: MessageEvent<string>) => {
      if (!active || ended) return;
      let next:
        | Frame
        | PageDialog
        | PageSelect
        | { type: "dialogClosed"; dialogId: string }
        | { type: "selectClosed"; pickerId: string }
        | { type: "error"; dialogId?: string; pickerId?: string };
      try {
        next = JSON.parse(data) as typeof next;
      } catch {
        socket.close();
        return;
      }
      if (!next || typeof next !== "object") {
        socket.close();
        return;
      }
      if (next.type === "error") {
        if (typeof next.dialogId === "string" || typeof next.pickerId === "string") socket.close();
        return;
      }
      if (next.type === "dialogClosed") {
        setDialog((current) => (current?.dialogId === next.dialogId ? null : current));
        return;
      }
      if (next.type === "selectClosed") {
        setPicker((current) => (current?.pickerId === next.pickerId ? null : current));
        return;
      }
      if (next.type === "select") {
        if (
          typeof next.pickerId !== "string" ||
          typeof next.pageId !== "string" ||
          typeof next.documentId !== "string" ||
          !Array.isArray(next.options) ||
          next.options.some(
            (option) =>
              !option ||
              typeof option.id !== "string" ||
              !option.id ||
              typeof option.label !== "string" ||
              typeof option.disabled !== "boolean" ||
              typeof option.selected !== "boolean",
          ) ||
          new Set(next.options.map((option) => option.id)).size !== next.options.length
        ) {
          socket.close();
          return;
        }
        const request = next;
        controlSequence++;
        let answered = false;
        setDialog(null);
        setPicker({
          ...request,
          pending: false,
          answer: (optionId) => {
            if (answered || !active || ended || socket.readyState !== WebSocket.OPEN) return;
            if (
              optionId !== null &&
              !request.options.some((option) => option.id === optionId && !option.disabled)
            )
              return;
            answered = true;
            setPicker((current) =>
              current?.pickerId === request.pickerId ? { ...current, pending: true } : current,
            );
            send({
              type: "select",
              pageId: request.pageId,
              documentId: request.documentId,
              pickerId: request.pickerId,
              optionId,
            });
          },
        });
        return;
      }
      if (next.type === "dialog") {
        if (
          typeof next.dialogId !== "string" ||
          typeof next.pageId !== "string" ||
          typeof next.documentId !== "string" ||
          typeof next.message !== "string" ||
          typeof next.defaultPrompt !== "string" ||
          !["alert", "confirm", "prompt", "beforeunload"].includes(next.dialogType)
        ) {
          socket.close();
          return;
        }
        const request = next;
        controlSequence++;
        let answered = false;
        setPicker(null);
        setDialog({
          ...request,
          pending: false,
          answer: (accept, promptText) => {
            if (answered || !active || ended || socket.readyState !== WebSocket.OPEN) return;
            answered = true;
            setDialog((current) =>
              current?.dialogId === request.dialogId ? { ...current, pending: true } : current,
            );
            send({
              type: "dialog",
              pageId: request.pageId,
              documentId: request.documentId,
              dialogId: request.dialogId,
              accept,
              ...(promptText !== undefined ? { promptText } : {}),
            });
          },
        });
        return;
      }
      if (next.type !== "frame") return;
      if (
        !Number.isSafeInteger(next.frameId) ||
        !Number.isSafeInteger(next.width) ||
        next.width <= 0 ||
        !Number.isSafeInteger(next.height) ||
        next.height <= 0 ||
        typeof next.pageId !== "string" ||
        typeof next.documentId !== "string" ||
        typeof next.data !== "string"
      ) {
        socket.close();
        return;
      }
      const controlAtReceipt = controlSequence;
      const picture = new Image();
      picture.onload = () => {
        if (!active || ended || socket.readyState !== WebSocket.OPEN) return;
        if (frame?.pageId !== next.pageId || frame?.documentId !== next.documentId) {
          heldKeys.clear();
          heldPointers.clear();
          lastPress = undefined;
          input.value = "";
          if (controlSequence === controlAtReceipt) {
            setDialog((current) =>
              current?.pageId === next.pageId && current.documentId === next.documentId
                ? current
                : null,
            );
            setPicker((current) =>
              current?.pageId === next.pageId && current.documentId === next.documentId
                ? current
                : null,
            );
          }
        }
        if (surface.width !== next.width) surface.width = next.width;
        if (surface.height !== next.height) surface.height = next.height;
        surface.getContext("2d")?.drawImage(picture, 0, 0, next.width, next.height);
        frame = next;
        setStatus("Connected");
        send({ type: "ack", frameId: next.frameId });
      };
      picture.onerror = () => socket.close();
      picture.src = `data:image/jpeg;base64,${next.data}`;
    };
    socket.onclose = socket.onerror = () => {
      ended = true;
      socket.close();
      frame = undefined;
      heldKeys.clear();
      heldPointers.clear();
      if (active) {
        setStatus("Disconnected");
        setDialog(null);
        setPicker(null);
      }
    };
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
      compositionFrame = frame;
    };
    const compositionEnd = () => {
      composing = false;
      if (
        !compositionFrame ||
        compositionFrame.pageId !== frame?.pageId ||
        compositionFrame.documentId !== frame.documentId
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
      if (!frame) return;
      event.preventDefault();
      if (kind === "down") input.focus({ preventScroll: true });
      const bounds = surface.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const scaleX = frame.width / bounds.width;
      const scaleY = frame.height / bounds.height;
      const wheelScale =
        "deltaMode" in event
          ? event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
              ? frame.height
              : 1
          : 1;
      const point = {
        x: Math.max(0, Math.min(frame.width - 1, (event.clientX - bounds.left) * scaleX)),
        y: Math.max(0, Math.min(frame.height - 1, (event.clientY - bounds.top) * scaleY)),
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
      if (!frame) return;
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
        pageId: frame.pageId,
        documentId: frame.documentId,
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
    return () => {
      releaseInput();
      active = false;
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
      socket.close();
    };
  }, [session.viewPath, connection]);

  return (
    <>
      <div
        className="absolute inset-0 flex h-full w-full items-center justify-center overflow-hidden focus-visible:-outline-offset-4"
        ref={host}
        role="application"
        tabIndex={0}
        aria-label="Managed browser. Press Enter to interact, F8 to leave the browser, then Tab to move to the next control."
      >
        <canvas
          ref={canvas}
          className="h-auto max-h-full w-auto max-w-full touch-none"
          aria-hidden="true"
        />
        <textarea
          ref={keyboardInput}
          tabIndex={-1}
          aria-label="Managed browser keyboard input"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="absolute top-0 left-0 h-px w-px resize-none opacity-0"
        />
      </div>
      {status !== "Connected" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/95 text-muted-foreground">
          <p className="my-[13px]">
            {status === "Connecting" ? "Connecting…" : "Browser disconnected."}
          </p>
          {status === "Disconnected" && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setStatus("Connecting");
                setConnection((previous) => previous + 1);
              }}
            >
              Reconnect view
            </Button>
          )}
        </div>
      )}
      <AlertDialog open={picker !== null}>
        {picker && (
          <AlertDialogContent
            key={picker.pickerId}
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              picker.answer(null);
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              optionInput.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              host.current?.focus();
            }}
          >
            <AlertDialogTitle>Choose an option</AlertDialogTitle>
            <AlertDialogDescription>
              Choose an option for the page, then apply it.
            </AlertDialogDescription>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (optionInput.current?.value) picker.answer(optionInput.current.value);
              }}
            >
              <label className="block space-y-1 text-sm">
                <span>Option</span>
                <select
                  ref={optionInput}
                  aria-label="Option"
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  defaultValue={picker.options.find((option) => option.selected)?.id ?? ""}
                  disabled={picker.pending}
                  required
                >
                  <option value="" disabled>
                    Choose an option
                  </option>
                  {picker.options.map((option) => (
                    <option key={option.id} value={option.id} disabled={option.disabled}>
                      {option.label || "(Unnamed option)"}
                    </option>
                  ))}
                </select>
              </label>
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={picker.pending}
                  onClick={() => picker.answer(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={picker.pending || !picker.options.some((option) => !option.disabled)}
                >
                  Apply
                </Button>
              </div>
            </form>
          </AlertDialogContent>
        )}
      </AlertDialog>
      <AlertDialog open={dialog !== null}>
        {dialog && (
          <AlertDialogContent
            key={dialog.dialogId}
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              dialog.answer(false);
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              (dialog.dialogType === "prompt"
                ? promptInput.current
                : cancelDialog.current
              )?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              host.current?.focus();
            }}
          >
            <AlertDialogTitle>
              {dialog.dialogType === "beforeunload"
                ? "Leave this page?"
                : dialog.dialogType === "prompt"
                  ? "Page prompt"
                  : dialog.dialogType === "alert"
                    ? "Page alert"
                    : "Page confirmation"}
            </AlertDialogTitle>
            <AlertDialogDescription className="max-h-64 overflow-y-auto break-words whitespace-pre-wrap">
              {dialog.message || "The page is waiting for your response."}
            </AlertDialogDescription>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                dialog.answer(
                  true,
                  dialog.dialogType === "prompt" ? (promptInput.current?.value ?? "") : undefined,
                );
              }}
            >
              {dialog.dialogType === "prompt" && (
                <Input
                  ref={promptInput}
                  aria-label="Response"
                  defaultValue={dialog.defaultPrompt}
                  disabled={dialog.pending}
                />
              )}
              <div className="mt-3 flex justify-end gap-2">
                {dialog.dialogType !== "alert" && (
                  <Button
                    ref={cancelDialog}
                    type="button"
                    variant="outline"
                    disabled={dialog.pending}
                    onClick={() => dialog.answer(false)}
                  >
                    {dialog.dialogType === "beforeunload" ? "Stay" : "Cancel"}
                  </Button>
                )}
                <Button
                  ref={dialog.dialogType === "alert" ? cancelDialog : undefined}
                  type="submit"
                  disabled={dialog.pending}
                >
                  {dialog.dialogType === "beforeunload" ? "Leave page" : "OK"}
                </Button>
              </div>
            </form>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </>
  );
}
