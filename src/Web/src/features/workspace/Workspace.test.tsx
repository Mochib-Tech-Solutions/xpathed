import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mockSystemTheme } from "@/test/systemTheme";
import { ThemeProvider } from "../theme/ThemeProvider";
import Workspace from "./Workspace";

vi.mock("@novnc/novnc", () => ({
  default: class extends EventTarget {
    disconnect = vi.fn();
    focus = vi.fn();
  },
}));

const session = { sessionId: "session-1", pageId: "page-1", viewPath: "/view/page-1" };
const page = {
  ...session,
  documentId: "document-1",
  url: "https://example.test/checkout",
  title: "Checkout",
  blockedPopups: 0,
};
const found = {
  contractVersion: "1",
  outcome: "found",
  sessionId: session.sessionId,
  pageId: session.pageId,
  documentId: page.documentId,
  captureId: "capture-1",
  frameId: "main",
  traceId: "trace-1",
  attemptId: "attempt-1",
  configurationId: "test-config",
  action: "click",
  target: {
    candidateId: "candidate-1",
    tag: "button",
    label: "Pay now",
    xpaths: ["//*[@data-testid='pay']", "//button[normalize-space(.)='Pay now']"],
    state: { rendered: true, inViewport: false, enabled: false, editable: false, checked: null },
    geometry: { x: 20, y: 1200, width: 100, height: 40 },
  },
  diagnostics: { code: null, message: null },
};

function renderWorkspace() {
  mockSystemTheme();
  return render(
    <ThemeProvider>
      <Workspace />
    </ThemeProvider>,
  );
}

function mockApi(resolve = () => Promise.resolve(Response.json(found)), currentPage = () => page) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>((input, options) => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (options?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      if (path === "/api/sessions") return Promise.resolve(Response.json(session));
      if (path === "/api/sessions/session-1")
        return Promise.resolve(
          Response.json({
            sessionId: session.sessionId,
            activePageId: page.pageId,
            activationVersion: 1,
            viewPath: session.viewPath,
            pages: [currentPage()],
          }),
        );
      if (path.endsWith("/resolve")) return resolve();
      return Promise.resolve(Response.json(currentPage()));
    }),
  );
}

async function openWorkspace() {
  const user = userEvent.setup();
  renderWorkspace();
  await user.type(screen.getByRole("textbox", { name: "Page address" }), `${page.url}{Enter}`);
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled(),
  );
  return user;
}

async function submitInstruction(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("textbox", { name: "Describe an element" }), "Click Pay now");
  await user.click(screen.getByRole("button", { name: "Resolve instruction" }));
}

describe("Workspace resolution", () => {
  it("reports a clipboard failure only on the history entry being copied", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByRole("heading", { name: "Pay now" });
    await user.click(screen.getByRole("button", { name: "Resolve instruction" }));
    await waitFor(() =>
      expect(screen.getAllByRole("heading", { name: "Pay now" })).toHaveLength(2),
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
          target: attempt === 1 ? found.target : null,
          diagnostics: { ...found.diagnostics, timingsMs: { total: attempt === 1 ? 1260 : 430 } },
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByRole("heading", { name: "Pay now" });
    const composer = screen.getByRole("textbox", { name: "Describe an element" });
    await user.clear(composer);
    await user.type(composer, "Click the missing button{Enter}");

    expect(await screen.findByText("No matching element found.")).toBeInTheDocument();
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

    expect(await screen.findByRole("heading", { name: "Pay now" })).toBeInTheDocument();
    expect(instruction).toHaveValue("Click Pay now");
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

    await screen.findByRole("heading", { name: "Pay now" });
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
    const theme = screen.getByRole("button", { name: /^Theme:/ });
    await user.click(theme);
    await user.keyboard("{Escape}");
    await act(async () => {
      finish(Response.json(found));
      await pending;
    });

    await screen.findByRole("heading", { name: "Pay now" });
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
    expect(await screen.findByRole("heading", { name: "Pay now" })).toBeInTheDocument();
  });

  it("shows the resolver's reported duration beside the result", async () => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          diagnostics: { ...found.diagnostics, timingsMs: { total: 1260 } },
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);

    expect(await screen.findByText("Resolution time: 1.26 s")).toBeInTheDocument();
  });

  it("omits duration when the resolver did not report one", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);

    await screen.findByRole("heading", { name: "Pay now" });
    expect(screen.queryByText(/Resolution time:/)).not.toBeInTheDocument();
  });

  it("reports a noneditable fill target as found with its observed state", async () => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          action: "fill",
          target: { ...found.target, tag: "input", label: "Name" },
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);

    expect(await screen.findByRole("heading", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByText("Not editable")).toBeInTheDocument();
    expect(screen.queryByText("No matching element found.")).not.toBeInTheDocument();
  });

  it("preserves a result as historical when polling detects a same-URL document change", async () => {
    let current = page;
    mockApi(undefined, () => current);
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByRole("heading", { name: "Pay now" });
    current = { ...page, documentId: "document-2" };

    await waitFor(() => expect(screen.getByText(/Earlier result/)).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled();
  });

  it.each([
    { name: "another page", result: { pageId: "page-2" }, current: {} },
    { name: "another document", result: { documentId: "document-2" }, current: {} },
    { name: "another session", result: { sessionId: "session-2" }, current: {} },
  ])("rejects a result from $name", async ({ result, current: changed }) => {
    let current = page;
    mockApi(
      () => Promise.resolve(Response.json({ ...found, ...result })),
      () => current,
    );
    const user = await openWorkspace();
    current = { ...page, ...changed };
    await submitInstruction(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The page changed. Resolve the instruction again.",
    );
    expect(screen.queryByRole("heading", { name: "Pay now" })).not.toBeInTheDocument();
  });

  it("preserves the previous result as historical when the user reloads the page", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByRole("heading", { name: "Pay now" });
    await user.click(screen.getByRole("button", { name: "Reload page" }));

    expect(screen.getByRole("heading", { name: "Pay now" })).toBeInTheDocument();
    expect(screen.getByText(/Earlier result/)).toBeInTheDocument();
  });

  it("closes all tabs and clears chat without creating a replacement session", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByRole("heading", { name: "Pay now" });
    expect(
      within(screen.getByRole("banner")).queryByRole("button", { name: /reset|close all/i }),
    ).not.toBeInTheDocument();
    await user.click(
      within(screen.getByRole("region", { name: "Browser workspace" })).getByRole("button", {
        name: "Close all tabs",
      }),
    );
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Close all tabs" }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Pay now" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeDisabled();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Page address" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Page address" })).toHaveFocus();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/sessions/session-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(
      vi.mocked(globalThis.fetch).mock.calls.filter(([input]) => input === "/api/sessions"),
    ).toHaveLength(1);
  });

  it("keeps the tabs and chat available if closing the session fails", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByRole("heading", { name: "Pay now" });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>((input, options) =>
        options?.method === "DELETE"
          ? Promise.resolve(
              Response.json({ message: "Unable to close the browser." }, { status: 503 }),
            )
          : originalFetch(input, options),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Close all tabs" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Close all tabs" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to close the browser.");
    expect(screen.getByRole("tab", { name: "Checkout" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pay now" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue(
      "Click Pay now",
    );
    expect(screen.getByRole("button", { name: "Close all tabs" })).toBeEnabled();
  });

  it("prevents duplicate resolution and navigation while a request is pending", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const resolve = vi.fn(() => pending);
    mockApi(resolve);
    const user = await openWorkspace();
    await submitInstruction(user);

    expect(screen.getByText("Resolving…")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resolve instruction" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close all tabs" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Resolve instruction" }));
    expect(resolve).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(Response.json(found));
      await pending;
    });
    expect(await screen.findByRole("heading", { name: "Pay now" })).toBeInTheDocument();
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

  it.each([
    {
      name: "network",
      response: () => Promise.reject(new TypeError("Failed to fetch")),
      message: "Failed to fetch",
    },
    {
      name: "HTTP",
      response: () =>
        Promise.resolve(
          Response.json({ message: "The resolver is unavailable." }, { status: 503 }),
        ),
      message: "The resolver is unavailable.",
    },
  ])(
    "reports a $name failure without inventing an absence result",
    async ({ response, message }) => {
      mockApi(response);
      const user = await openWorkspace();
      await submitInstruction(user);

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(screen.queryByText("No matching element found.")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Resolve instruction" })).toBeEnabled();
    },
  );

  it("marks a late result historical after manual navigation and updates the shown page address", async () => {
    let current = page;
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    mockApi(
      () => pending,
      () => current,
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    current = { ...page, documentId: "document-2", url: "https://example.test/done" };
    await act(async () => {
      finish(Response.json(found));
      await pending;
    });

    expect(await screen.findByText(/Earlier result/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pay now" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Page address" })).toHaveValue(
      "https://example.test/done",
    );
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

  it("reports provider failures as errors rather than semantic absence", async () => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          outcome: "error",
          target: null,
          diagnostics: {
            code: "provider_rate_limit",
            message: "The model provider is rate limited.",
          },
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);

    expect(await screen.findByText("Resolution failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The model provider is rate limited.");
    expect(screen.queryByText("No matching element found.")).not.toBeInTheDocument();
  });

  it("distinguishes unsupported instructions from absence", async () => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          outcome: "unsupported",
          target: null,
          diagnostics: {
            code: "unsupported_action",
            message: "This instruction requests multiple targets.",
          },
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);

    expect(await screen.findByText("Unsupported instruction")).toBeInTheDocument();
    expect(screen.getByText("This instruction requests multiple targets.")).toBeInTheDocument();
    expect(screen.queryByText("No matching element found.")).not.toBeInTheDocument();
  });

  it("reports semantic absence without displaying a target", async () => {
    mockApi(() => Promise.resolve(Response.json({ ...found, outcome: "not_found", target: null })));
    const user = await openWorkspace();
    await submitInstruction(user);

    expect(await screen.findByText("No matching element found.")).toBeInTheDocument();
    expect(
      screen.queryByRole("list", { name: "Verified XPath alternatives" }),
    ).not.toBeInTheDocument();
  });

  it("resolves the managed page and displays one target with ordered copyable XPaths and state", async () => {
    const user = userEvent.setup();
    const fetch = vi.fn<typeof globalThis.fetch>((input, options) => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (path === "/api/sessions") return Promise.resolve(Response.json(session));
      if (path === "/api/sessions/session-1")
        return Promise.resolve(
          Response.json({
            sessionId: session.sessionId,
            activePageId: page.pageId,
            activationVersion: 1,
            viewPath: session.viewPath,
            pages: [page],
          }),
        );
      if (path === "/api/pages/page-1/resolve") {
        expect(JSON.parse(typeof options?.body === "string" ? options.body : "null")).toEqual({
          instruction: "Click Pay now",
          documentId: "document-1",
        });
        return Promise.resolve(Response.json(found));
      }
      return Promise.resolve(Response.json(page));
    });
    vi.stubGlobal("fetch", fetch);
    renderWorkspace();

    await user.type(screen.getByRole("textbox", { name: "Page address" }), `${page.url}{Enter}`);
    const instruction = screen.getByRole("textbox", { name: "Describe an element" });
    await waitFor(() => expect(instruction).toBeEnabled());
    await user.type(instruction, "Click Pay now");
    await user.click(screen.getByRole("button", { name: "Resolve instruction" }));

    expect(await screen.findByRole("heading", { name: "Pay now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy XPath 2" })).not.toBeVisible();
    await user.click(screen.getByText("1 alternative XPath"));
    expect(screen.getByRole("button", { name: "Copy XPath 2" })).toBeVisible();
    expect(
      screen.getAllByRole("listitem").map((item) => item.querySelector("code")?.textContent),
    ).toEqual(found.target.xpaths);
    expect(screen.getByText("Off-screen")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy XPath 1" }));
    expect(await navigator.clipboard.readText()).toBe("//*[@data-testid='pay']");
    expect(screen.getByText("Copied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /execute/i })).not.toBeInTheDocument();
  });
});
