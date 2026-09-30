import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mockSystemTheme } from "@/test/systemTheme";
import { ThemeProvider } from "../theme/ThemeProvider";
import Workspace from "./Workspace";
import type { PageState } from "./api";

vi.mock("@novnc/novnc", () => ({
  default: class extends EventTarget {
    disconnect = vi.fn();
    focus = vi.fn();
  },
}));

function browserApi() {
  const session = { sessionId: "session-1", pageId: "page-1", viewPath: "/view/session-1" };
  let pages: PageState[] = [
    {
      sessionId: session.sessionId,
      pageId: "page-1",
      documentId: "document-1",
      url: "about:blank",
      title: "",
      blockedPopups: 0,
    },
  ];
  let activePageId = "page-1";
  let nextId = 2;
  let activationVersion = 1;
  let snapshotFailure = false;
  const snapshot = () => ({
    sessionId: session.sessionId,
    activePageId,
    activationVersion,
    viewPath: session.viewPath,
    pages,
  });
  const addPage = (url = "about:blank", title = "") => {
    const id = nextId++;
    const page = {
      sessionId: session.sessionId,
      pageId: `page-${id}`,
      documentId: `document-${id}`,
      url,
      title,
      blockedPopups: 0,
    };
    pages = [...pages, page];
    activePageId = page.pageId;
    activationVersion++;
    return page;
  };
  const result = (page: PageState, instruction: string) => ({
    contractVersion: "1",
    outcome: "found",
    sessionId: session.sessionId,
    pageId: page.pageId,
    documentId: page.documentId,
    captureId: "capture",
    frameId: "main",
    traceId: "trace",
    attemptId: instruction,
    configurationId: "test",
    action: "click",
    target: {
      candidateId: "button",
      tag: "button",
      label: `${page.title} target`,
      xpaths: ["//button"],
      state: { rendered: true, inViewport: true, enabled: true, editable: false, checked: null },
      geometry: { x: 10, y: 20, width: 50, height: 30 },
    },
    diagnostics: { code: null, message: null, timingsMs: { total: 123 } },
  });
  let resolveRequest = (page: PageState, instruction: string) =>
    Promise.resolve(Response.json(result(page, instruction)));
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, options) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (path === "/api/sessions") return Response.json(session);
    if (path === "/api/sessions/session-1" && snapshotFailure)
      return Response.json({ message: "Cannot verify current tabs." }, { status: 503 });
    if (path === "/api/sessions/session-1")
      return options?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json(snapshot());
    if (path === "/api/sessions/session-1/pages") {
      addPage();
      return Response.json(snapshot());
    }
    const pageId = path.split("/")[3];
    const page = pages.find((entry) => entry.pageId === pageId);
    if (!page) return Response.json({ message: "Page not found" }, { status: 404 });
    if (path.endsWith("/activate")) {
      activePageId = page.pageId;
      activationVersion++;
      return Response.json(snapshot());
    }
    if (options?.method === "DELETE") {
      pages = pages.filter((entry) => entry !== page);
      if (!pages.length) addPage();
      if (activePageId === page.pageId) {
        activePageId = pages[0]!.pageId;
        activationVersion++;
      }
      return Response.json(snapshot());
    }
    if (path.endsWith("/navigate")) {
      const { url } = JSON.parse(typeof options?.body === "string" ? options.body : "null") as {
        url: string;
      };
      page.url = url;
      page.title = url.includes("second") ? "Second" : "First";
      page.documentId += "-n";
      return Response.json(page);
    }
    if (path.endsWith("/resolve")) {
      const { instruction } = JSON.parse(
        typeof options?.body === "string" ? options.body : "null",
      ) as { instruction: string };
      return resolveRequest({ ...page }, instruction);
    }
    return Response.json(page);
  });
  vi.stubGlobal("fetch", fetch);
  return {
    addPage,
    snapshot,
    result,
    failSnapshot: () => {
      snapshotFailure = true;
    },
    returnToSameTab: () => {
      activationVersion += 2;
    },
    setResolve: (next: typeof resolveRequest) => {
      resolveRequest = next;
    },
  };
}
function renderWorkspace() {
  mockSystemTheme();
  render(
    <ThemeProvider>
      <Workspace />
    </ThemeProvider>,
  );
  return userEvent.setup();
}
async function openFirst(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("textbox", { name: "Page address" }), "first.test{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled(),
  );
}

describe("Browser tabs and chat", () => {
  it("keeps keyboard focus on the selected tab after switching and closing", async () => {
    browserApi();
    const user = renderWorkspace();
    await openFirst(user);
    await user.click(screen.getByRole("button", { name: "New tab" }));
    const address = screen.getByRole("textbox", { name: "Page address" });
    await waitFor(() => expect(address).toHaveFocus());
    await user.type(address, "second.test{Enter}");
    const second = await screen.findByRole("tab", { name: "Second" });
    await user.click(second);
    await user.keyboard("{Home}");
    await waitFor(() => expect(screen.getByRole("tab", { name: "First" })).toHaveFocus());
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(second).toHaveFocus());
    await user.keyboard("{Delete}");
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Second" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: "First" })).toHaveFocus();
    await user.tab();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("tab", { name: "New tab" })).toHaveFocus());
  });

  it("blocks native tab shortcuts in the viewer while keeping normal page typing and copying", async () => {
    browserApi();
    const user = renderWorkspace();
    await openFirst(user);
    const viewer = await screen.findByRole("application");
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
    ]) {
      expect(fireEvent.keyDown(viewer, { ...shortcut, bubbles: true, cancelable: true })).toBe(
        false,
      );
    }
    expect(
      fireEvent.keyDown(viewer, { key: "c", ctrlKey: true, bubbles: true, cancelable: true }),
    ).toBe(true);
    expect(fireEvent.keyDown(viewer, { key: "a", bubbles: true, cancelable: true })).toBe(true);
  });

  it("keeps an unverified response as historical when the final session refresh fails", async () => {
    const api = browserApi();
    const user = renderWorkspace();
    await openFirst(user);
    api.setResolve((page, instruction) => {
      api.failSnapshot();
      return Promise.resolve(Response.json(api.result(page, instruction)));
    });
    await user.type(
      screen.getByRole("textbox", { name: "Describe an element" }),
      "Click First{Enter}",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot verify current tabs.");
    expect(screen.getByText(/Earlier result/)).toBeInTheDocument();
  });

  it("marks an in-flight result historical after an unseen tab roundtrip", async () => {
    const api = browserApi();
    let finish!: (response: Response) => void;
    let originalPage!: PageState;
    api.setResolve((page) => {
      originalPage = page;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    const user = renderWorkspace();
    await openFirst(user);
    await user.type(
      screen.getByRole("textbox", { name: "Describe an element" }),
      "Click First{Enter}",
    );
    api.returnToSameTab();
    await act(() =>
      Promise.resolve(finish(Response.json(api.result(originalPage, "Click First")))),
    );
    expect(await screen.findByText(/Earlier result/)).toBeInTheDocument();
  });

  it("discovers an activated popup while resolving and keeps a late result in its originating tab", async () => {
    const api = browserApi();
    let finish!: (response: Response) => void;
    let originalPage!: PageState;
    api.setResolve((page) => {
      originalPage = page;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    const user = renderWorkspace();
    await openFirst(user);
    await user.type(
      screen.getByRole("textbox", { name: "Describe an element" }),
      "Click First{Enter}",
    );
    api.addPage("https://popup.test/", "Popup");
    await waitFor(
      () =>
        expect(screen.getByRole("tab", { name: "Popup" })).toHaveAttribute("aria-selected", "true"),
      { timeout: 3000 },
    );
    expect(screen.queryByText("Click First", { selector: "p" })).not.toBeInTheDocument();
    await act(() =>
      Promise.resolve(finish(Response.json(api.result(originalPage, "Click First")))),
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled(),
    );
    expect(screen.queryByRole("heading", { name: "First target" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "First" }));
    expect(await screen.findByRole("heading", { name: "First target" })).toBeInTheDocument();
    expect(screen.getByText(/Earlier result/)).toBeInTheDocument();
    expect(screen.getByText("https://first.test", { selector: "p" })).toBeInTheDocument();
  });

  it("closing the last tab clears its chat and leaves an empty tab ready for a website", async () => {
    browserApi();
    const user = renderWorkspace();
    await openFirst(user);
    await user.type(
      screen.getByRole("textbox", { name: "Describe an element" }),
      "Click First{Enter}",
    );
    await screen.findByRole("heading", { name: "First target" });
    await user.click(screen.getByRole("button", { name: "Close First tab and clear its chat" }));
    expect(await screen.findByRole("tab", { name: "New tab" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByRole("heading", { name: "First target" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Page address" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeDisabled();
  });

  it("keeps separate chat and drafts when creating and selecting browser tabs", async () => {
    browserApi();
    const user = renderWorkspace();
    await openFirst(user);
    const composer = () => screen.getByRole("textbox", { name: "Describe an element" });
    await user.type(composer(), "Click First{Enter}");
    await screen.findByRole("heading", { name: "First target" });
    await user.clear(composer());
    await user.type(composer(), "Draft for First");
    await user.click(screen.getByRole("button", { name: "New tab" }));
    await waitFor(() => expect(composer()).toBeDisabled());
    await user.type(screen.getByRole("textbox", { name: "Page address" }), "second.test{Enter}");
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "Click Second{Enter}");
    await screen.findByRole("heading", { name: "Second target" });
    expect(screen.queryByText("Click First", { selector: "p" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "First" }));
    expect(await screen.findByText("Click First", { selector: "p" })).toBeInTheDocument();
    expect(composer()).toHaveValue("Draft for First");
    expect(screen.queryByText("Click Second", { selector: "p" })).not.toBeInTheDocument();
    expect(screen.getByText(/Earlier result/)).toBeInTheDocument();
  });
});
