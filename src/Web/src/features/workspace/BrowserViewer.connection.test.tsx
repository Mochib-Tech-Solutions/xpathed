import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import BrowserViewer from "./BrowserViewer";
import { Socket, Picture, session, frame, socket, sent, draw } from "./viewerTestUtils";

describe("BrowserViewer connection", () => {
  it("automatically reconnects without replaying input and cancels retries on unmount", () => {
    vi.useFakeTimers();
    try {
      const view = render(<BrowserViewer session={session} />);
      draw();
      const oldSocket = socket();
      const connections = Socket.instances.length;
      act(() => oldSocket.onclose?.());
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(Socket.instances).toHaveLength(connections + 1);
      expect(socket().url.pathname).toBe(session.viewPath);
      expect(sent()).toEqual([]);
      draw();
      act(() => oldSocket.onclose?.());
      expect(screen.queryByText("Browser disconnected.")).not.toBeInTheDocument();
      act(() => socket().onclose?.());
      view.unmount();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(Socket.instances).toHaveLength(connections + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies cursor feedback only to its displayed document and rejects cursor URLs", () => {
    const view = render(<BrowserViewer session={session} />);
    const surface = view.container.querySelector("canvas")!;
    const cursor = (pageId: string, documentId: string, value: string) =>
      act(() =>
        socket().onmessage?.({
          data: JSON.stringify({ type: "cursor", pageId, documentId, cursor: value }),
        }),
      );
    draw();
    cursor("p1", "d1", "pointer");
    expect(surface.style.cursor).toBe("pointer");
    cursor("other", "d1", "text");
    cursor("p1", "old", "text");
    cursor("p1", "d1", "url(https://example.test/cursor.png), pointer");
    expect(surface.style.cursor).toBe("pointer");
    cursor("p1", "d2", "text");
    draw({ ...frame, frameId: 2, documentId: "d2" });
    expect(surface.style.cursor).toBe("text");
    draw({ ...frame, frameId: 3, documentId: "d3" });
    expect(surface.style.cursor).toBe("default");
    cursor("p1", "d3", "not-allowed");
    expect(surface.style.cursor).toBe("not-allowed");
    act(() => socket().onclose?.());
    expect(surface.style.cursor).toBe("default");
  });

  it("does not revive a disconnected viewer when an old image finishes decoding", () => {
    render(<BrowserViewer session={session} />);
    act(() => socket().onmessage?.({ data: JSON.stringify(frame) }));
    act(() => socket().onclose?.());
    act(() => Picture.instances.at(-1)?.onload?.());
    expect(screen.getByRole("button", { name: "Reconnect view" })).toBeInTheDocument();
    expect(socket().send).not.toHaveBeenCalled();
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
});
