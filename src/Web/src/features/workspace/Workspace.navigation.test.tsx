import { render, screen, waitFor, within } from "@testing-library/react";
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

const session = {
  sessionId: "session-1",
  pageId: "page-1",
  viewPath: "/view/page-1",
  browserType: "chromium" as const,
};
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
          input === "/api/sessions/options"
            ? { defaultBrowserType: "chromium", browserTypes: ["chromium", "firefox"] }
            : input === "/api/sessions"
              ? session
              : input === "/api/sessions/session-1"
                ? {
                    sessionId: session.sessionId,
                    activePageId: page.pageId,
                    activationVersion: 1,
                    viewPath: session.viewPath,
                    browserType: "chromium" as const,
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
    expect(fetch.mock.calls.filter(([input]) => input === "/api/sessions")).toHaveLength(0);
    const strip = screen.getByRole("tablist", { name: "Browser tabs" });
    expect(screen.getByRole("tab", { name: "New tab" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("New tab");
    expect(screen.getByRole("button", { name: "New tab" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close all tabs" })).toBeDisabled();
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
    expect(screen.getByRole("tablist", { name: "Browser tabs" })).toBe(strip);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Example" })).toHaveAttribute("aria-selected", "true");
  });
  it("uses the configured default, sends the chosen engine and unlocks it only after closing the session", async () => {
    let selectedType = "firefox";
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, options) => {
      if (input === "/api/sessions/options")
        return Response.json({
          defaultBrowserType: "firefox",
          browserTypes: ["chromium", "firefox"],
        });
      if (options?.method === "DELETE") return new Response(null, { status: 204 });
      if (input === "/api/sessions") {
        selectedType = ((await new Response(options?.body).json()) as { browserType: string })
          .browserType;
        return Response.json({ ...session, browserType: selectedType });
      }
      if (input === "/api/sessions/session-1")
        return Response.json({
          ...session,
          browserType: selectedType,
          activePageId: page.pageId,
          activationVersion: 1,
          pages: [page],
        });
      return Response.json(page);
    });
    vi.stubGlobal("fetch", fetch);
    const user = renderWorkspace();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Browser type: Firefox" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Browser type: Firefox" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Chromium" }));
    await user.type(screen.getByRole("textbox", { name: "Page address" }), "example.test{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled(),
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ browserType: "chromium" }),
      }),
    );
    expect(screen.getByRole("button", { name: "Browser type: Chromium" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close all tabs" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Browser type: Chromium" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close all tabs" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Close all tabs" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Browser type: Chromium" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Browser type: Chromium" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Firefox" }));
    await user.type(screen.getByRole("textbox", { name: "Page address" }), "example.test{Enter}");
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/sessions",
        expect.objectContaining({ body: JSON.stringify({ browserType: "firefox" }) }),
      ),
    );
  });

  it("keeps the browser and address after a navigation failure so the user can retry", async () => {
    let attempts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      if (input === "/api/sessions/options")
        return Promise.resolve(
          Response.json({ defaultBrowserType: "chromium", browserTypes: ["chromium", "firefox"] }),
        );
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
            browserType: "chromium" as const,
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
