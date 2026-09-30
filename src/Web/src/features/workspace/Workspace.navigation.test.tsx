import { render, screen, waitFor } from "@testing-library/react";
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
  url: "https://example.test/",
  title: "Example",
  blockedPopups: 0,
};

function renderWorkspace() {
  mockSystemTheme();
  render(
    <ThemeProvider>
      <Workspace />
    </ThemeProvider>,
  );
  return userEvent.setup();
}

describe("Workspace navigation", () => {
  it("creates a browser and opens the submitted website without a separate start step", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((input) =>
      Promise.resolve(
        Response.json(
          input === "/api/sessions"
            ? session
            : input === "/api/sessions/session-1"
              ? {
                  sessionId: session.sessionId,
                  activePageId: page.pageId,
                  activationVersion: 1,
                  viewPath: session.viewPath,
                  pages: [page],
                }
              : page,
        ),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const user = renderWorkspace();
    const address = screen.getByRole("textbox", { name: "Page address" });

    expect(address).toBeEnabled();
    expect(address).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Open browser" })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    await user.type(address, "example.test{Enter}");

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled(),
    );
    expect(fetch.mock.calls.filter(([input]) => input === "/api/sessions")).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(
      "/api/pages/page-1/navigate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ url: "https://example.test" }),
      }),
    );
    expect(address).toHaveValue("https://example.test/");
  });
  it("keeps the browser and address after a navigation failure so the user can retry", async () => {
    let attempts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      if (input === "/api/sessions") return Promise.resolve(Response.json(session));
      if (input === "/api/pages/page-1/navigate" && ++attempts === 1)
        return Promise.resolve(
          Response.json({ message: "This website could not be opened." }, { status: 502 }),
        );
      if (input === "/api/sessions/session-1")
        return Promise.resolve(
          Response.json({
            sessionId: session.sessionId,
            activePageId: page.pageId,
            activationVersion: 1,
            viewPath: session.viewPath,
            pages: [attempts < 2 ? { ...page, url: "about:blank" } : page],
          }),
        );
      return Promise.resolve(Response.json(page));
    });
    vi.stubGlobal("fetch", fetch);
    const user = renderWorkspace();
    const address = screen.getByRole("textbox", { name: "Page address" });
    await user.type(address, "example.test{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("This website could not be opened.");
    expect(address).toBeEnabled();
    expect(address).toHaveValue("example.test");
    await user.click(screen.getByRole("button", { name: "Go to address" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetch.mock.calls.filter(([input]) => input === "/api/sessions")).toHaveLength(1);
    expect(attempts).toBe(2);
  });
});
