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
  it("shows a direct single-target reply without repeated instructions or technical boilerplate", async () => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          contractVersion: "2",
          target: null,
          action: null,
          inspectedActionId: "a1",
          summary: {
            total: 1,
            found: 1,
            notFound: 0,
            unsupported: 0,
            errors: 0,
            blocked: 0,
            readinessUnknown: 1,
          },
          actions: [
            {
              actionId: "a1",
              order: 1,
              instruction: "Click Pay now",
              action: "click",
              outcome: "found",
              target: { ...found.target, interactability: { status: "unknown", reasons: [] } },
            },
          ],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByRole("heading", { name: "Pay now" });
    const transcript = screen.getByRole("log");
    expect(within(transcript).getAllByText("Click Pay now")).toHaveLength(1);
    expect(within(transcript).queryByText(page.url)).not.toBeInTheDocument();
    expect(within(transcript).queryByText(page.title)).not.toBeInTheDocument();
    expect(
      within(transcript).queryByText(/No action was executed|Semantic completeness|Event delivery/),
    ).not.toBeInTheDocument();
    expect(within(transcript).queryByText(/1 target found/)).not.toBeInTheDocument();
    expect(within(transcript).getByText(found.target.xpaths[0]!)).toBeVisible();
    expect(
      within(transcript).queryByRole("button", { name: /Inspect action/ }),
    ).not.toBeInTheDocument();
    expect(within(transcript).queryByText(found.target.xpaths[1]!)).not.toBeInTheDocument();
    expect(
      within(transcript).queryByText(/Verified XPaths|alternative XPath|State details/),
    ).not.toBeInTheDocument();
    expect(within(transcript).getByText("Interaction readiness unknown.")).toBeVisible();
    expect(within(transcript).getByText("Off-screen")).toBeVisible();
  });

  it("renders independent action results with one request cost and no inspection control", async () => {
    const batch = {
      ...found,
      contractVersion: "2",
      outcome: "partial",
      action: null,
      target: null,
      inspectedActionId: "a1",
      summary: {
        processingComplete: true,
        semanticCompleteness: "unverified",
        total: 2,
        found: 1,
        notFound: 1,
        unsupported: 0,
        errors: 0,
        blocked: 1,
        readinessUnknown: 0,
        assessmentUnsupported: 0,
      },
      actions: [
        {
          actionId: "a1",
          order: 1,
          step: 1,
          instruction: "Click Pay now",
          action: "click",
          outcome: "found",
          target: found.target,
          frameId: "main",
          diagnosticsReference: "attempt-1",
          code: null,
          message: null,
        },
        {
          actionId: "a2",
          order: 2,
          step: 2,
          instruction: "Hover Contact",
          action: "hover",
          outcome: "not_found",
          target: null,
          frameId: "main",
          diagnosticsReference: "attempt-1",
          code: null,
          message: "I couldn’t find that element on this page.",
        },
      ],
    };
    mockApi(() => Promise.resolve(Response.json(batch)));
    const user = await openWorkspace();
    await submitInstruction(user);
    expect(await screen.findByText("1 target found · 1 missing · 1 blocked")).toBeInTheDocument();
    expect(screen.getByText(/Hover Contact/)).toBeInTheDocument();
    expect(screen.getByText("I couldn’t find that element on this page.")).toBeInTheDocument();
    expect(screen.getAllByText("Cost unavailable")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Inspect action/ })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/pages/page-1/resolve",
      expect.objectContaining({
        body: JSON.stringify({
          instruction: "Click Pay now",
          documentId: "document-1",
          contractVersion: "2",
        }),
      }),
    );
  });

  it.each([
    ["ready", [], "Interaction checks passed."],
    ["blocked", ["disabled", "off_screen"], "Interaction blocked."],
    ["unknown", [], "Interaction readiness unknown."],
    ["unsupported", ["custom_control_unverified"], "Interaction assessment unsupported."],
  ])(
    "shows %s readiness while retaining target, XPath and diagnostics",
    async (status, reasons, message) => {
      mockApi(() =>
        Promise.resolve(
          Response.json({
            ...found,
            target: {
              ...found.target,
              interactability: {
                version: status === "ready" ? "2" : "1",
                action: "click",
                status,
                reasons,
                checks: { eventOutcome: "unknown" },
              },
            },
            diagnostics: { ...found.diagnostics, timingsMs: { total: 125 } },
          }),
        ),
      );
      const user = await openWorkspace();
      await submitInstruction(user);
      expect(await screen.findByText(message)).toBeVisible();
      expect(screen.getByRole("heading", { name: "Pay now" })).toBeInTheDocument();
      expect(screen.getByText("Resolution time: 125 ms")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Copy XPath 1" })).toBeInTheDocument();
      if (status === "blocked")
        expect(screen.getByText("This element is disabled.")).toBeInTheDocument();
      expect(
        screen.queryByText("Event delivery and action success were not tested."),
      ).not.toBeInTheDocument();
    },
  );

  it("shows structured cost details on hover and keyboard focus without mixing estimates and charges", async () => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          diagnostics: {
            ...found.diagnostics,
            model: "deepseek/deepseek-v4.1-flash",
            provider: "Wafer",
            usage: {
              inputTokens: 140,
              outputTokens: 15,
              totalTokens: 155,
              reasoningTokens: 0,
              cachedTokens: null,
              cost: 0.0000215,
            },
            costEstimate: {
              currency: "USD",
              inputPricePerMillion: 0.0749,
              outputPricePerMillion: 0.44,
              inputCost: 0.000010486,
              outputCost: 0.0000066,
              requestCost: 0,
              totalCost: 0.000017086,
              pricingFetchedAt: "2026-09-30T09:00:00Z",
            },
          },
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    const cost = await screen.findByRole("button", { name: "Estimated cost: $0.00001709" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(cost);
    const tooltip = screen.getByRole("tooltip");
    expect(within(tooltip).getByText("$0.0749")).toBeInTheDocument();
    expect(within(tooltip).getByText("$0.44")).toBeInTheDocument();
    expect(within(tooltip).getByText("$0.0000215")).toBeInTheDocument();
    expect(within(tooltip).getByText("140")).toBeInTheDocument();
    expect(within(tooltip).getByText("Unavailable")).toBeInTheDocument();
    await user.unhover(cost);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    act(() => cost.focus());
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(cost).toHaveFocus();
  });

  it("shows a reported zero charge when rates are missing and unavailable when usage is missing", async () => {
    let attempt = 0;
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          diagnostics: {
            ...found.diagnostics,
            costEstimate: null,
            usage:
              ++attempt === 1
                ? {
                    inputTokens: null,
                    outputTokens: null,
                    totalTokens: null,
                    reasoningTokens: null,
                    cachedTokens: null,
                    cost: 0,
                  }
                : null,
          },
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    const cost = await screen.findByRole("button", { name: "Reported cost: $0.00" });
    await user.hover(cost);
    expect(within(screen.getByRole("tooltip")).getAllByText("Unavailable")).toHaveLength(12);
    await user.unhover(cost);
    await user.click(screen.getByRole("button", { name: "Resolve instruction" }));
    expect(await screen.findByRole("button", { name: "Cost unavailable" })).toBeInTheDocument();
  });

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

    expect(
      await screen.findByText("I couldn’t find that element on this page."),
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
    expect(
      screen.queryByText("I couldn’t find that element on this page."),
    ).not.toBeInTheDocument();
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
    expect(screen.getByText(found.target.xpaths[0]!)).toBeVisible();
    expect(screen.queryByText(found.target.xpaths[1]!)).not.toBeInTheDocument();
    expect(screen.getByText("Interaction readiness unavailable.")).toBeVisible();
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

  it("reopens with fresh chat and ignores a delayed snapshot from the closed session", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByRole("heading", { name: "Pay now" });
    const originalFetch = globalThis.fetch;
    const freshSession = { sessionId: "session-2", pageId: "page-2", viewPath: "/view/session-2" };
    const freshPage = {
      ...page,
      ...freshSession,
      documentId: "document-2",
      url: "https://fresh.test/",
      title: "Fresh page",
    };
    let finishOldSnapshot: ((response: Response) => void) | undefined;
    const resolveFresh = vi.fn(() =>
      Promise.resolve(
        Response.json({
          ...found,
          sessionId: freshSession.sessionId,
          pageId: freshPage.pageId,
          documentId: freshPage.documentId,
          target: { ...found.target, label: "Fresh target" },
        }),
      ),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>((input, options) => {
        if (input === "/api/sessions/session-1" && options?.method === "GET")
          return new Promise<Response>((resolve) => {
            finishOldSnapshot = resolve;
          });
        if (input === "/api/sessions") return Promise.resolve(Response.json(freshSession));
        if (input === "/api/sessions/session-2")
          return Promise.resolve(
            Response.json({
              ...freshSession,
              activePageId: freshPage.pageId,
              activationVersion: 1,
              pages: [freshPage],
            }),
          );
        if (input === "/api/pages/page-2/navigate")
          return Promise.resolve(Response.json(freshPage));
        if (input === "/api/pages/page-2/resolve") return resolveFresh();
        return originalFetch(input, options);
      }),
    );
    await waitFor(() => expect(finishOldSnapshot).toBeTypeOf("function"), { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: "Close all tabs" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Close all tabs" }),
    );
    await waitFor(() => expect(screen.queryByRole("tablist")).not.toBeInTheDocument());
    await user.type(screen.getByRole("textbox", { name: "Page address" }), "fresh.test{Enter}");
    expect(await screen.findByRole("tab", { name: "Fresh page" })).toBeInTheDocument();
    await act(() =>
      Promise.resolve(
        finishOldSnapshot!(
          Response.json({
            ...session,
            activePageId: page.pageId,
            activationVersion: 1,
            pages: [page],
          }),
        ),
      ),
    );
    expect(screen.queryByRole("tab", { name: "Checkout" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pay now" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue("");
    await user.type(
      screen.getByRole("textbox", { name: "Describe an element" }),
      "Click Fresh target{Enter}",
    );
    expect(await screen.findByRole("heading", { name: "Fresh target" })).toBeInTheDocument();
    expect(resolveFresh).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/pages/page-2/resolve",
      expect.objectContaining({
        body: JSON.stringify({
          instruction: "Click Fresh target",
          documentId: "document-2",
          contractVersion: "2",
        }),
      }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
      expect(
        screen.queryByText("I couldn’t find that element on this page."),
      ).not.toBeInTheDocument();
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

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The model provider is rate limited.");
    expect(
      screen.queryByText("I couldn’t find that element on this page."),
    ).not.toBeInTheDocument();
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
            message: "Drag and drop is unsupported.",
          },
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);

    expect(await screen.findByText("This interaction is not supported yet.")).toBeInTheDocument();
    expect(
      screen.queryByText("I couldn’t find that element on this page."),
    ).not.toBeInTheDocument();
  });

  it("reports semantic absence without displaying a target", async () => {
    mockApi(() => Promise.resolve(Response.json({ ...found, outcome: "not_found", target: null })));
    const user = await openWorkspace();
    await submitInstruction(user);

    expect(
      await screen.findByText("I couldn’t find that element on this page."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy XPath 1" })).not.toBeInTheDocument();
  });

  it("resolves the managed page and displays one copyable XPath with inline state", async () => {
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
          contractVersion: "2",
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
    expect(screen.queryByRole("button", { name: "Copy XPath 2" })).not.toBeInTheDocument();
    expect(screen.queryByText(found.target.xpaths[1]!)).not.toBeInTheDocument();
    expect(screen.queryByText("1 alternative XPath")).not.toBeInTheDocument();
    expect(screen.getByText("Off-screen")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy XPath 1" }));
    expect(await navigator.clipboard.readText()).toBe("//*[@data-testid='pay']");
    expect(screen.getByText("Copied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /execute/i })).not.toBeInTheDocument();
  });
});
