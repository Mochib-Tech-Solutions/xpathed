import type { Dispatch, SetStateAction } from "react";
import type {
  Frame,
  PageCursor,
  PageDialog,
  PageSelect,
  ViewerStatus,
  DialogState,
  SelectState,
} from "./viewerProtocol";
import bindViewerInput from "./bindViewerInput";

const cursors = new Set(
  "auto default none context-menu help pointer progress wait cell crosshair text vertical-text alias copy move no-drop not-allowed grab grabbing all-scroll col-resize row-resize n-resize e-resize s-resize w-resize ne-resize nw-resize se-resize sw-resize ew-resize ns-resize nesw-resize nwse-resize zoom-in zoom-out".split(
    " ",
  ),
);

export default function connectViewer(
  viewPath: string,
  container: HTMLDivElement,
  surface: HTMLCanvasElement,
  input: HTMLTextAreaElement,
  setStatus: Dispatch<SetStateAction<ViewerStatus>>,
  setDialog: Dispatch<SetStateAction<DialogState | null>>,
  setPicker: Dispatch<SetStateAction<SelectState | null>>,
) {
  let active = true;
  let ended = false;
  let controlSequence = 0;
  const state: { frame?: Frame; cursor?: PageCursor } = {};
  surface.style.cursor = "default";
  const updateCursor = () => {
    surface.style.cursor =
      state.cursor?.pageId === state.frame?.pageId &&
      state.cursor?.documentId === state.frame?.documentId
        ? (state.cursor?.cursor ?? "default")
        : "default";
  };
  const url = new URL(viewPath, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  const send = (message: object) => {
    if (active && !ended && socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  };
  const command = (message: object) => {
    if (state.frame)
      send({ ...message, pageId: state.frame.pageId, documentId: state.frame.documentId });
  };
  const binding = bindViewerInput(container, surface, input, state, send, command);
  socket.onmessage = ({ data }: MessageEvent<string>) => {
    if (!active || ended) return;
    let next:
      | Frame
      | PageCursor
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
    if (next.type === "cursor") {
      if (
        typeof next.pageId === "string" &&
        typeof next.documentId === "string" &&
        cursors.has(next.cursor)
      ) {
        state.cursor = next;
        if (next.pageId === state.frame?.pageId && next.documentId === state.frame.documentId)
          updateCursor();
      }
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
      const documentChanged =
        state.frame?.pageId !== next.pageId || state.frame?.documentId !== next.documentId;
      if (documentChanged) {
        binding.reset();
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
      state.frame = next;
      if (documentChanged) updateCursor();
      setStatus("Connected");
      send({ type: "ack", frameId: next.frameId });
    };
    picture.onerror = () => socket.close();
    picture.src = `data:image/jpeg;base64,${next.data}`;
  };
  socket.onclose = socket.onerror = () => {
    if (!active || ended) return;
    ended = true;
    socket.close();
    state.frame = undefined;
    state.cursor = undefined;
    updateCursor();
    binding.clearHeld();
    if (active) {
      setStatus("Disconnected");
      setDialog(null);
      setPicker(null);
    }
  };
  return () => {
    binding.release();
    active = false;
    binding.dispose();
    socket.close();
  };
}
