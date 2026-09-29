import { act, render, screen, waitFor, within } from "@testing-library/react";
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
      if (path.endsWith("/resolve")) return resolve();
      return Promise.resolve(Response.json(currentPage()));
    }),
  );
}

async function openWorkspace() {
  const user = userEvent.setup();
  renderWorkspace();
  await user.click(screen.getByRole("button", { name: "Open browser" }));
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

  it("clears a displayed result when polling detects a same-URL document change", async () => {
    let current = page;
    mockApi(undefined, () => current);
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByRole("heading", { name: "Pay now" });
    current = { ...page, documentId: "document-2" };

    await waitFor(
      () => expect(screen.queryByRole("heading", { name: "Pay now" })).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled();
  });

  it.each([
    { name: "another page", result: { pageId: "page-2" }, current: {} },
    { name: "another document", result: { documentId: "document-2" }, current: {} },
    { name: "another session", result: { sessionId: "session-2" }, current: {} },
    { name: "a same-URL reload", result: {}, current: { documentId: "document-2" } },
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

  it("clears the previous result when the user reloads the page", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByRole("heading", { name: "Pay now" });
    await user.click(screen.getByRole("button", { name: "Reload page" }));

    expect(screen.queryByRole("heading", { name: "Pay now" })).not.toBeInTheDocument();
  });

  it("clears the instruction and result after a confirmed session reset", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByRole("heading", { name: "Pay now" });
    await user.click(screen.getByRole("button", { name: "Reset session" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Reset session" }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Pay now" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue("");
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
    expect(screen.getByRole("button", { name: "Reset session" })).toBeDisabled();
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
    await user.click(screen.getByRole("button", { name: "Open browser" }));
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

  it("discards a result after manual navigation and updates the shown page address", async () => {
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

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The page changed. Resolve the instruction again.",
    );
    expect(screen.queryByRole("heading", { name: "Pay now" })).not.toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "Open browser" }));
    const instruction = screen.getByRole("textbox", { name: "Describe an element" });
    await waitFor(() => expect(instruction).toBeEnabled());
    await user.type(instruction, "Click Pay now");
    await user.click(screen.getByRole("button", { name: "Resolve instruction" }));

    expect(await screen.findByRole("heading", { name: "Pay now" })).toBeInTheDocument();
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
