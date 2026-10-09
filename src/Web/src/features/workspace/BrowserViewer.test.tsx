import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BrowserViewer from "./BrowserViewer";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  send = vi.fn();
  close = vi.fn();
  constructor(readonly url: URL) {
    Socket.instances.push(this);
  }
}

class Picture {
  static instances: Picture[] = [];
  onload?: () => void;
  onerror?: () => void;
  src = "";
  constructor() {
    Picture.instances.push(this);
  }
}

const session = {
  sessionId: "s1",
  pageId: "p1",
  viewPath: "/view/s1",
  browserType: "chromium" as const,
  resolution: "1280x800",
};
const frame = {
  type: "frame",
  frameId: 1,
  pageId: "p1",
  documentId: "d1",
  width: 1280,
  height: 800,
  data: "image",
};
const picker = {
  type: "select",
  pageId: "p1",
  documentId: "d1",
  pickerId: "picker-1",
  options: [
    { id: "option-a", label: "First option", disabled: false, selected: true },
    { id: "option-b", label: "Second option", disabled: false, selected: false },
    { id: "option-c", label: "Unavailable", disabled: true, selected: false },
  ],
};
const socket = () => Socket.instances.at(-1)!;
const sent = () =>
  socket().send.mock.calls.map(
    ([message]) => JSON.parse(message as string) as Record<string, unknown>,
  );
function draw(value = frame) {
  act(() => socket().onmessage?.({ data: JSON.stringify(value) }));
  act(() => Picture.instances.at(-1)?.onload?.());
}

beforeEach(() => {
  Socket.instances = [];
  Picture.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("Image", Picture);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
});

describe("BrowserViewer", () => {
  it("applies one explicitly chosen native option using only its retained identity", () => {
    render(<BrowserViewer session={session} />);
    act(() => socket().onmessage?.({ data: JSON.stringify(picker) }));
    const choice = screen.getByRole("combobox", { name: "Option" });
    expect(choice).toHaveValue("option-a");
    expect(choice).toHaveFocus();
    expect(screen.getByRole("option", { name: "Unavailable" })).toBeDisabled();
    expect(socket().send).not.toHaveBeenCalled();
    fireEvent.change(choice, { target: { value: "option-b" } });
    expect(socket().send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(sent()).toEqual([
      {
        type: "select",
        pageId: "p1",
        documentId: "d1",
        pickerId: "picker-1",
        optionId: "option-b",
      },
    ]);
    expect(choice).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    act(() =>
      socket().onmessage?.({ data: JSON.stringify({ type: "selectClosed", pickerId: "older" }) }),
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    act(() =>
      socket().onmessage?.({
        data: JSON.stringify({ type: "selectClosed", pickerId: "picker-1" }),
      }),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it.each(["Cancel", "Escape"])(
    "cancels a native option picker with %s without selecting",
    (action) => {
      render(<BrowserViewer session={session} />);
      act(() => socket().onmessage?.({ data: JSON.stringify(picker) }));
      if (action === "Cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      else fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
      expect(sent()).toEqual([
        {
          type: "select",
          pageId: "p1",
          documentId: "d1",
          pickerId: "picker-1",
          optionId: null,
        },
      ]);
    },
  );

  it("retires a native picker on document changes or page dialogs without choosing an option", () => {
    render(<BrowserViewer session={session} />);
    draw();
    act(() => socket().onmessage?.({ data: JSON.stringify(picker) }));
    draw({ ...frame, frameId: 2, documentId: "d2" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    act(() => socket().onmessage?.({ data: JSON.stringify({ ...picker, documentId: "d2" }) }));
    act(() =>
      socket().onmessage?.({
        data: JSON.stringify({
          type: "dialog",
          pageId: "p1",
          documentId: "d2",
          dialogId: "d2-dialog",
          dialogType: "alert",
          message: "Hello",
          defaultPrompt: "",
        }),
      }),
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Page alert");
    expect(sent().filter((item) => item.type === "select")).toHaveLength(0);
  });

  it("recovers from a rejected picker answer without replaying it", () => {
    render(<BrowserViewer session={session} />);
    act(() => socket().onmessage?.({ data: JSON.stringify(picker) }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    act(() =>
      socket().onmessage?.({
        data: JSON.stringify({ type: "error", pickerId: "picker-1", code: "stale_picker" }),
      }),
    );
    expect(socket().close).toHaveBeenCalled();
    act(() => socket().onclose?.());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect view" }));
    expect(socket().send).not.toHaveBeenCalled();
  });

  it("rejects malformed option identities and keeps ordinary stale input errors nonfatal", () => {
    render(<BrowserViewer session={session} />);
    draw();
    act(() =>
      socket().onmessage?.({ data: JSON.stringify({ type: "error", code: "stale_document" }) }),
    );
    expect(socket().close).not.toHaveBeenCalled();
    act(() =>
      socket().onmessage?.({
        data: JSON.stringify({ ...picker, options: [picker.options[0], picker.options[0]] }),
      }),
    );
    expect(socket().close).toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("keeps a newer picker when an earlier document frame finishes decoding", () => {
    render(<BrowserViewer session={session} />);
    act(() => socket().onmessage?.({ data: JSON.stringify(frame) }));
    act(() => socket().onmessage?.({ data: JSON.stringify({ ...picker, documentId: "d2" }) }));
    act(() => Picture.instances.at(-1)?.onload?.());
    expect(screen.getByRole("combobox", { name: "Option" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(sent().at(-1)).toMatchObject({ type: "select", documentId: "d2", optionId: null });
  });

  it("does not revive a disconnected viewer when an old image finishes decoding", () => {
    render(<BrowserViewer session={session} />);
    act(() => socket().onmessage?.({ data: JSON.stringify(frame) }));
    act(() => socket().onclose?.());
    act(() => Picture.instances.at(-1)?.onload?.());
    expect(screen.getByRole("button", { name: "Reconnect view" })).toBeInTheDocument();
    expect(socket().send).not.toHaveBeenCalled();
  });

  it("allows dead keys to compose and routes Option text through native key events", () => {
    render(<BrowserViewer session={session} />);
    draw();
    const input = screen.getByRole("textbox", { name: "Managed browser keyboard input" });
    expect(
      fireEvent.keyDown(input, { key: "Dead", code: "KeyE", altKey: true, cancelable: true }),
    ).toBe(true);
    fireEvent.compositionStart(input);
    fireEvent.input(input, { target: { value: "é" } });
    fireEvent.compositionEnd(input);
    expect(
      fireEvent.keyDown(input, { key: "∂", code: "KeyD", altKey: true, cancelable: true }),
    ).toBe(false);
    expect(
      sent()
        .filter((item) => item.type === "text")
        .map((item) => item.text),
    ).toEqual(["é"]);
    expect(sent().at(-1)).toEqual({
      type: "key",
      event: "down",
      key: "∂",
      code: "KeyD",
      modifiers: 1,
      text: "∂",
      pageId: "p1",
      documentId: "d1",
    });
  });

  it("reconnects after a rejected dialog answer without replaying the answer", () => {
    render(<BrowserViewer session={session} />);
    act(() =>
      socket().onmessage?.({
        data: JSON.stringify({
          type: "dialog",
          pageId: "p1",
          documentId: "d1",
          dialogId: "dialog-1",
          dialogType: "confirm",
          message: "Continue?",
          defaultPrompt: "",
        }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    act(() =>
      socket().onmessage?.({
        data: JSON.stringify({ type: "error", code: "stale_dialog", dialogId: "dialog-1" }),
      }),
    );
    expect(socket().close).toHaveBeenCalled();
    act(() => socket().onclose?.());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(sent().filter((item) => item.type === "dialog")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Reconnect view" })).toBeInTheDocument();
  });
  it("asks before answering a page prompt and binds the answer to that dialog", () => {
    render(<BrowserViewer session={session} />);
    const dialog = {
      type: "dialog",
      pageId: "p1",
      documentId: "d1",
      dialogId: "dialog-1",
      dialogType: "prompt",
      message: "Choose a name",
      defaultPrompt: "Original",
    };
    act(() => socket().onmessage?.({ data: JSON.stringify(dialog) }));
    expect(socket().send).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox", { name: "Response" });
    expect(input).toHaveValue("Original");
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(sent()).toEqual([
      {
        type: "dialog",
        pageId: "p1",
        documentId: "d1",
        dialogId: "dialog-1",
        accept: true,
        promptText: "New name",
      },
    ]);
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
    act(() =>
      socket().onmessage?.({ data: JSON.stringify({ type: "dialogClosed", dialogId: "older" }) }),
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    act(() =>
      socket().onmessage?.({
        data: JSON.stringify({ type: "dialogClosed", dialogId: "dialog-1" }),
      }),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
  it("blocks browser chrome shortcuts while the viewer is focused", () => {
    render(<BrowserViewer session={session} />);
    const viewer = screen.getByRole("application");
    for (const shortcut of [
      { key: "t", ctrlKey: true },
      { key: "n", metaKey: true },
      { key: "l", ctrlKey: true },
      { key: "Tab", ctrlKey: true },
      { key: "F11" },
      { key: "F12" },
      { key: "i", ctrlKey: true, shiftKey: true },
      { key: "j", ctrlKey: true, shiftKey: true },
      { key: "c", ctrlKey: true, shiftKey: true },
      { key: "d", altKey: true },
    ])
      expect(fireEvent.keyDown(viewer, { ...shortcut, bubbles: true, cancelable: true })).toBe(
        false,
      );
    expect(
      fireEvent.keyDown(viewer, { key: "c", ctrlKey: true, bubbles: true, cancelable: true }),
    ).toBe(true);
    expect(fireEvent.keyDown(viewer, { key: "a", bubbles: true, cancelable: true })).toBe(true);
  });
  it("acknowledges a frame only after drawing it and closes owned connections", () => {
    const view = render(<BrowserViewer session={session} />);
    act(() => socket().onmessage?.({ data: JSON.stringify(frame) }));
    expect(socket().send).not.toHaveBeenCalled();
    act(() => Picture.instances.at(-1)?.onload?.());
    expect(sent()).toEqual([{ type: "ack", frameId: 1 }]);
    expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();
    view.unmount();
    expect(Socket.instances.every((item) => item.close.mock.calls.length === 1)).toBe(true);
    act(() => Picture.instances.at(-1)?.onload?.());
    expect(socket().send).toHaveBeenCalledTimes(1);
  });

  it("sends Unicode, composition and paste once with the displayed document identity", () => {
    render(<BrowserViewer session={session} />);
    draw();
    const input = screen.getByRole("textbox", { name: "Managed browser keyboard input" });
    fireEvent.input(input, { target: { value: "é" } });
    fireEvent.compositionStart(input);
    fireEvent.input(input, { target: { value: "日本語" } });
    expect(sent().filter((item) => item.type === "text")).toHaveLength(1);
    fireEvent.compositionEnd(input);
    fireEvent.input(input);
    fireEvent.paste(input, { clipboardData: { getData: () => "hello 👋" } });
    expect(sent().filter((item) => item.type === "text")).toEqual(
      ["é", "日本語", "hello 👋"].map((text) => ({
        type: "text",
        text,
        pageId: "p1",
        documentId: "d1",
      })),
    );
    draw({ ...frame, frameId: 2, pageId: "p2", documentId: "d2" });
    fireEvent.input(input, { target: { value: "new page" } });
    expect(sent().at(-1)).toEqual({
      type: "text",
      text: "new page",
      pageId: "p2",
      documentId: "d2",
    });
  });

  it("keeps keyboard entry and F8 escape accessible without forwarding browser shortcuts", () => {
    render(<BrowserViewer session={session} />);
    draw();
    const host = screen.getByRole("application");
    const input = screen.getByRole("textbox", { name: "Managed browser keyboard input" });
    host.focus();
    fireEvent.keyDown(host, { key: "Enter", code: "Enter" });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Tab", code: "Tab" });
    fireEvent.keyUp(input, { key: "Tab", code: "Tab" });
    fireEvent.keyDown(input, { key: "l", code: "KeyL", ctrlKey: true });
    fireEvent.keyDown(input, { key: "F8", code: "F8" });
    expect(host).toHaveFocus();
    expect(sent().filter((item) => item.type === "key")).toEqual([
      {
        type: "key",
        event: "down",
        key: "Tab",
        code: "Tab",
        modifiers: 0,
        pageId: "p1",
        documentId: "d1",
      },
      {
        type: "key",
        event: "up",
        key: "Tab",
        code: "Tab",
        modifiers: 0,
        pageId: "p1",
        documentId: "d1",
      },
    ]);
    act(() => socket().onclose?.());
    fireEvent.input(input, { target: { value: "disconnected" } });
    expect(sent().filter((item) => item.type === "text")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Reconnect view" })).toBeInTheDocument();
  });

  it("forwards hardware text, space and repeats as native keys without duplicate text insertion", () => {
    render(<BrowserViewer session={session} />);
    draw();
    const input = screen.getByRole("textbox", { name: "Managed browser keyboard input" });
    for (const [key, code] of [
      ["a", "KeyA"],
      [" ", "Space"],
    ]) {
      expect(fireEvent.keyDown(input, { key, code, cancelable: true })).toBe(false);
      fireEvent.keyUp(input, { key, code });
    }
    fireEvent.keyDown(input, { key: "a", code: "KeyA", repeat: true });
    expect(sent().filter((item) => item.type === "text")).toHaveLength(0);
    expect(sent().filter((item) => item.type === "key" && item.event === "down")).toMatchObject([
      { key: "a", text: "a" },
      { key: " ", text: " " },
      { key: "a", text: "a", repeat: true },
    ]);
    fireEvent.keyDown(input, { key: "a", code: "KeyA", ctrlKey: true });
    expect(sent().at(-1)).not.toHaveProperty("text");
  });

  it("does not commit an old composition into a different document", () => {
    render(<BrowserViewer session={session} />);
    draw();
    const input = screen.getByRole("textbox", { name: "Managed browser keyboard input" });
    fireEvent.compositionStart(input);
    fireEvent.input(input, { target: { value: "old composition" } });
    draw({ ...frame, frameId: 2, documentId: "d2" });
    fireEvent.input(input, { target: { value: "old composition" } });
    fireEvent.compositionEnd(input);
    fireEvent.input(input);
    expect(sent().filter((item) => item.type === "text")).toHaveLength(0);
    fireEvent.compositionStart(input);
    fireEvent.input(input, { target: { value: "new composition" } });
    fireEvent.compositionEnd(input);
    expect(sent().at(-1)).toMatchObject({
      type: "text",
      text: "new composition",
      documentId: "d2",
    });
  });

  it("releases pointer capture without clicking on cancel or window blur and counts double clicks", () => {
    const { container } = render(<BrowserViewer session={session} />);
    draw();
    const canvas = container.querySelector("canvas")!;
    canvas.setPointerCapture = vi.fn();
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 1280,
      height: 800,
    } as DOMRect);
    const pointer = (name: string, buttons: number) => {
      const event = new MouseEvent(name, {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 120,
        button: 0,
        buttons,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(canvas, event);
    };
    pointer("pointerdown", 1);
    pointer("pointerup", 0);
    pointer("pointerdown", 1);
    pointer("pointerup", 0);
    expect(
      sent()
        .filter((item) => item.type === "mouse")
        .map((item) => item.clickCount),
    ).toEqual([1, 1, 2, 2]);
    pointer("pointerdown", 1);
    pointer("pointerup", 0);
    pointer("pointerdown", 1);
    expect(sent().at(-1)).toMatchObject({ event: "down", clickCount: 3 });
    pointer("pointerup", 0);
    pointer("pointerdown", 1);
    pointer("pointercancel", 0);
    expect(sent().at(-1)).toMatchObject({
      type: "mouse",
      event: "up",
      button: "left",
      clickCount: 0,
      buttons: 0,
      documentId: "d1",
    });
    pointer("pointerdown", 1);
    fireEvent.blur(window);
    expect(sent().at(-1)).toMatchObject({ event: "up", clickCount: 0, buttons: 0, modifiers: 0 });
    const count = sent().length;
    pointer("lostpointercapture", 0);
    expect(sent()).toHaveLength(count);
  });

  it("maps scaled pointer and wheel input to viewport pixels", () => {
    const { container } = render(<BrowserViewer session={session} />);
    draw();
    const canvas = container.querySelector("canvas")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 20,
      top: 30,
      width: 640,
      height: 400,
    } as DOMRect);
    fireEvent.wheel(canvas, {
      clientX: 180,
      clientY: 130,
      deltaY: 3,
      deltaMode: 1,
      shiftKey: true,
    });
    expect(sent().at(-1)).toEqual({
      type: "mouse",
      event: "wheel",
      x: 320,
      y: 200,
      button: "none",
      buttons: 0,
      deltaX: 0,
      deltaY: 48,
      modifiers: 8,
      pageId: "p1",
      documentId: "d1",
    });
  });
});
