import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import BrowserViewer from "./BrowserViewer";
import { Picture, session, frame, picker, socket, sent, draw } from "./viewerTestUtils";

describe("BrowserViewer picker", () => {
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
});
