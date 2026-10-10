import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  session,
  page,
  target,
  found,
  mockApi,
  renderWorkspace,
  openWorkspace,
  submitInstruction,
} from "./workspaceTestUtils";

vi.mock("./BrowserViewer", () => ({ default: () => <div aria-label="Managed browser" /> }));

describe("Workspace lifecycle", () => {
  it("releases the browser session when the workspace unmounts", async () => {
    mockApi();
    await openWorkspace();
    cleanup();

    expect(globalThis.fetch).toHaveBeenCalledWith(`/api/sessions/${session.sessionId}`, {
      method: "DELETE",
      keepalive: true,
    });
  });

  it("closes a session whose creation completes after the workspace unmounts", async () => {
    mockApi();
    const originalFetch = globalThis.fetch;
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>((input, options) =>
        input === "/api/sessions"
          ? new Promise<Response>((resolve) => {
              finish = resolve;
            })
          : originalFetch(input, options),
      ),
    );
    const { unmount } = renderWorkspace();
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Page address" }), `${page.url}{Enter}`);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    unmount();
    await act(() => Promise.resolve(finish(Response.json(session))));

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `/api/sessions/${session.sessionId}`,
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      `/api/pages/${session.pageId}/navigate`,
      expect.anything(),
    );
  });

  it("preserves a result as historical when polling detects a same-URL document change", async () => {
    let current = page;
    mockApi(undefined, () => current);
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByText("Pay now", { selector: "bdi" });
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
      () =>
        Promise.resolve(
          Response.json({
            ...found,
            ...result,
            target: null,
            actions: [
              {
                actionId: "a1",
                order: 1,
                instruction: "Click Pay now",
                action: "click",
                outcome: "found",
                target: target,
              },
            ],
          }),
        ),
      () => current,
    );
    const user = await openWorkspace();
    current = { ...page, ...changed };
    await submitInstruction(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The page changed. Resolve the instruction again.",
    );
    expect(screen.queryByText("Pay now", { selector: "bdi" })).not.toBeInTheDocument();
  });

  it("preserves the previous result as historical when the user reloads the page", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByText("Pay now", { selector: "bdi" });
    await user.click(screen.getByRole("button", { name: "Reload page" }));

    expect(screen.getByText("Pay now", { selector: "bdi" })).toBeInTheDocument();
    expect(screen.getByText(/Earlier result/)).toBeInTheDocument();
    expect(screen.getByText(target.xpaths[0]!)).toBeVisible();
    expect(screen.queryByText(target.xpaths[1]!)).not.toBeInTheDocument();
    expect(screen.getByText("Interaction readiness unavailable.")).toBeVisible();
  });

  it("closes all tabs and clears chat without creating a replacement session", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByText("Pay now", { selector: "bdi" });
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
      expect(screen.queryByText("Pay now", { selector: "bdi" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "New tab" })).toHaveAttribute("aria-selected", "true");
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
    await screen.findByText("Pay now", { selector: "bdi" });
    const originalFetch = globalThis.fetch;
    const freshSession = {
      sessionId: "session-2",
      pageId: "page-2",
      viewPath: "/view/session-2",
      browserType: "chromium" as const,
      resolution: "1280x800",
    };
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
          target: null,
          actions: [
            {
              actionId: "a1",
              order: 1,
              instruction: "Click Pay now",
              action: "click",
              outcome: "found",
              target: { ...target, label: "Fresh target" },
            },
          ],
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
        if (input === "/api/sessions/options")
          return Promise.resolve(
            Response.json({
              defaultBrowserType: "chromium",
              browserTypes: ["chromium"],
              defaultResolution: "1280x800",
              resolutions: [
                { id: "1280x800", width: 1280, height: 800 },
                { id: "1920x1080", width: 1920, height: 1080 },
              ],
            }),
          );
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
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "New tab" })).toHaveAttribute("aria-selected", "true"),
    );
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
    expect(screen.queryByText("Pay now", { selector: "bdi" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue("");
    await user.type(
      screen.getByRole("textbox", { name: "Describe an element" }),
      "Click Fresh target{Enter}",
    );
    expect(await screen.findByText("Fresh target", { selector: "bdi" })).toBeInTheDocument();
    expect(resolveFresh).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/pages/page-2/resolve",
      expect.objectContaining({
        body: JSON.stringify({
          instruction: "Click Fresh target",
          documentId: "document-2",
          imageMode: "auto",
        }),
      }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the tabs and chat available if closing the session fails", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByText("Pay now", { selector: "bdi" });
    await user.type(screen.getByRole("textbox", { name: "Describe an element" }), "Next draft");
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
    expect(screen.getByText("Pay now", { selector: "bdi" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue("Next draft");
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
    expect(await screen.findByText("Pay now", { selector: "bdi" })).toBeInTheDocument();
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
        screen.queryByText("I couldn’t find that element in the current view."),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled();
      expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue("");
      expect(screen.getByRole("button", { name: "Resolve instruction" })).toBeDisabled();
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
    expect(screen.getByText("Pay now", { selector: "bdi" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Page address" })).toHaveValue(
      "https://example.test/done",
    );
  });
});
