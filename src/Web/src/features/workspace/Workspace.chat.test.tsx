import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  page,
  target,
  found,
  renderWorkspace,
  mockApi,
  openWorkspace,
  submitInstruction,
} from "./workspaceTestUtils";

vi.mock("./BrowserViewer", () => ({ default: () => <div aria-label="Managed browser" /> }));

describe("Workspace chat", () => {
  it.each([false, true])(
    "timestamps sent and received messages, including failure=%s",
    async (failure) => {
      let finish!: (response: Response) => void;
      mockApi(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const user = await openWorkspace();
      const sentAt = new Date("2026-09-30T19:24:00.000Z");
      const receivedAt = new Date("2026-09-30T19:25:02.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(sentAt);
      try {
        await submitInstruction(user);
        expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue("");
        expect(screen.getByLabelText("Sent message")).toHaveTextContent("Click Pay now");
        const sent = screen.getByLabelText(/^Sent /, { selector: "time" });
        expect(sent).toHaveAttribute("datetime", sentAt.toISOString());
        expect(screen.queryByLabelText(/^Received /, { selector: "time" })).not.toBeInTheDocument();
        expect(
          within(screen.getByLabelText("Response message")).getByText("Resolving…"),
        ).toBeVisible();
        vi.setSystemTime(receivedAt);
        finish(
          failure
            ? Response.json({ message: "Provider unavailable" }, { status: 502 })
            : Response.json({
                ...found,
                diagnostics: { ...found.diagnostics, timingsMs: { total: 739 } },
                target: null,
                actions: [
                  {
                    actionId: "a1",
                    order: 1,
                    instruction: "Click Pay now",
                    action: "click",
                    outcome: "found",
                    target: target,
                    code: null,
                    message: null,
                  },
                ],
              }),
        );
        const received = await screen.findByLabelText(/^Received /, { selector: "time" });
        expect(received).toHaveAttribute("datetime", receivedAt.toISOString());
        expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue("");
        expect(sent).toHaveAttribute("datetime", sentAt.toISOString());
        expect(sent).toHaveTextContent(
          sentAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        );
        expect(received).toHaveTextContent(
          receivedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        );
        if (failure) expect(screen.getByRole("alert")).toHaveTextContent("Provider unavailable");
        else {
          const response = within(screen.getByLabelText("Response message"));
          const content = [
            response.getByRole("heading", { name: "Button" }),
            response.getByText("Action: click"),
            response.getByText(target.xpaths[0]!),
            response.getByRole("heading", { name: "Verification" }),
          ];
          for (let index = 0; index < content.length - 1; index++) {
            expect(content[index]!.compareDocumentPosition(content[index + 1]!)).toBe(
              Node.DOCUMENT_POSITION_FOLLOWING,
            );
          }
          expect(response.getByText("Resolution time: 739 ms")).toBeVisible();
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("reports a clipboard failure only on the history entry being copied", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByText("Pay now", { selector: "bdi" });
    await submitInstruction(user);
    await waitFor(() =>
      expect(screen.getAllByText("Pay now", { selector: "bdi" })).toHaveLength(2),
    );
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new Error("Clipboard unavailable"),
    );
    await user.click(
      within(screen.getAllByRole("article").at(-1)!).getByRole("button", { name: "Copy XPath 1" }),
    );
    expect(await screen.findAllByRole("alert")).toHaveLength(1);
  });

  it("keeps earlier instructions, outcomes and reported times in the current tab chat", async () => {
    let attempt = 0;
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          outcome: ++attempt === 1 ? "found" : "not_found",
          diagnostics: { ...found.diagnostics, timingsMs: { total: attempt === 1 ? 1260 : 430 } },
          target: null,
          actions: [
            {
              actionId: "a1",
              order: 1,
              instruction: "Click Pay now",
              action: "click",
              outcome: attempt === 1 ? "found" : "not_found",
              target: attempt === 1 ? target : null,
              code: null,
              message: null,
            },
          ],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByText("Pay now", { selector: "bdi" });
    const composer = screen.getByRole("textbox", { name: "Describe an element" });
    await user.clear(composer);
    await user.type(composer, "Click the missing button{Enter}");

    expect(
      await screen.findByText("I couldn’t find that element in the current view."),
    ).toBeInTheDocument();
    expect(screen.getByText("Click Pay now")).toBeInTheDocument();
    expect(screen.getByText("Click the missing button", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("Resolution time: 1.26 s")).toBeInTheDocument();
    expect(screen.getByText("Resolution time: 430 ms")).toBeInTheDocument();
  });

  it("sends an instruction with Enter", async () => {
    mockApi();
    const user = await openWorkspace();
    const instruction = screen.getByRole("textbox", { name: "Describe an element" });
    await user.type(instruction, "Click Pay now{Enter}");

    expect(await screen.findByText("Pay now", { selector: "bdi" })).toBeInTheDocument();
    expect(instruction).toHaveValue("");
  });

  it("returns focus to the composer when a sent request completes", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    mockApi(() => pending);
    const user = await openWorkspace();
    await submitInstruction(user);
    await act(async () => {
      finish(Response.json(found));
      await pending;
    });

    await screen.findByText("Pay now", { selector: "bdi" });
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveFocus();
  });

  it("keeps focus on another control when a sent request completes", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    mockApi(() => pending);
    const user = await openWorkspace();
    await submitInstruction(user);
    const theme = screen.getByRole("button", { name: "Switch to light theme" });
    await user.click(theme);
    await user.keyboard("{Escape}");
    await act(async () => {
      finish(Response.json(found));
      await pending;
    });

    await screen.findByText("Pay now", { selector: "bdi" });
    expect(theme).toHaveFocus();
  });

  it("inserts a Ctrl+Enter newline at the selected text and keeps the caret there", async () => {
    const resolve = vi.fn(() => Promise.resolve(Response.json(found)));
    mockApi(resolve);
    const user = await openWorkspace();
    const instruction = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Describe an element",
    });
    await user.type(instruction, "Click the Pay now button");
    instruction.setSelectionRange(9, 18);
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(instruction).toHaveValue("Click the\nbutton");
    expect(instruction.selectionStart).toBe(10);
    expect(instruction.selectionEnd).toBe(10);
    expect(resolve).not.toHaveBeenCalled();
    await user.keyboard("primary ");
    expect(instruction).toHaveValue("Click the\nprimary button");
  });

  it("does not submit Enter while an IME composition is active", async () => {
    const resolve = vi.fn(() => Promise.resolve(Response.json(found)));
    mockApi(resolve);
    const user = await openWorkspace();
    const instruction = screen.getByRole("textbox", { name: "Describe an element" });
    await user.type(instruction, "Click 確認");
    fireEvent.keyDown(instruction, { key: "Enter", isComposing: true });
    fireEvent.keyDown(instruction, { key: "Enter", keyCode: 229 });

    expect(resolve).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Pay now", { selector: "bdi" })).toBeInTheDocument();
  });

  it("requires an open page and a nonblank instruction", async () => {
    mockApi();
    const user = userEvent.setup();
    renderWorkspace();
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resolve instruction" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Page address" }), `${page.url}{Enter}`);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled(),
    );
    await user.type(screen.getByRole("textbox", { name: "Describe an element" }), "   ");

    expect(screen.getByRole("button", { name: "Resolve instruction" })).toBeDisabled();
  });

  it("blocks instructions exceeding the service limit without truncating the text", async () => {
    mockApi();
    const user = await openWorkspace();
    const instruction = screen.getByRole("textbox", { name: "Describe an element" });
    await user.click(instruction);
    await user.paste("a".repeat(4001));

    expect(instruction).toHaveValue("a".repeat(4001));
    expect(screen.getByRole("button", { name: "Resolve instruction" })).toBeDisabled();
    expect(screen.getByText("Use 4,000 characters or fewer.")).toBeInTheDocument();
  });
});
