import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mockSystemTheme } from "@/test/systemTheme";
import { ThemeProvider } from "../theme/ThemeProvider";
import Workspace from "./Workspace";

vi.mock("./BrowserViewer", () => ({ default: () => <div aria-label="Managed browser" /> }));

const session = {
  sessionId: "session-1",
  pageId: "page-1",
  viewPath: "/view/page-1",
  browserType: "chromium" as const,
  resolution: "1280x800",
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
            ? {
                defaultBrowserType: "chromium",
                browserTypes: ["chromium"],
                defaultResolution: "1280x800",
                resolutions: [
                  { id: "1280x800", width: 1280, height: 800 },
                  { id: "1920x1080", width: 1920, height: 1080 },
                ],
              }
            : input === "/api/sessions"
              ? session
              : input === "/api/sessions/session-1"
                ? {
                    sessionId: session.sessionId,
                    activePageId: page.pageId,
                    activationVersion: 1,
                    viewPath: session.viewPath,
                    browserType: "chromium" as const,
                    resolution: "1280x800",
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
  it("sends the chosen resolution and unlocks it only after closing the session", async () => {
    let selectedType = "chromium";
    let selectedResolution = "1280x800";
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, options) => {
      if (input === "/api/sessions/options")
        return Response.json({
          defaultBrowserType: "chromium",
          browserTypes: ["chromium"],
          defaultResolution: "1280x800",
          resolutions: [
            { id: "1280x800", width: 1280, height: 800 },
            { id: "1920x1080", width: 1920, height: 1080 },
          ],
        });
      if (options?.method === "DELETE") return new Response(null, { status: 204 });
      if (input === "/api/sessions") {
        const selection = (await new Response(options?.body).json()) as {
          browserType: string;
          resolution: string;
        };
        selectedType = selection.browserType;
        selectedResolution = selection.resolution;
        return Response.json({
          ...session,
          browserType: selectedType,
          resolution: selectedResolution,
        });
      }
      if (input === "/api/sessions/session-1")
        return Response.json({
          ...session,
          browserType: selectedType,
          resolution: selectedResolution,
          activePageId: page.pageId,
          activationVersion: 1,
          pages: [page],
        });
      return Response.json(page);
    });
    vi.stubGlobal("fetch", fetch);
    const user = renderWorkspace();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Browser resolution: 1280x800" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Browser resolution: 1280x800" }));
    await user.click(screen.getByRole("menuitemradio", { name: "1920 × 1080" }));
    await user.type(screen.getByRole("textbox", { name: "Page address" }), "example.test{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled(),
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ browserType: "chromium", resolution: "1920x1080" }),
      }),
    );
    expect(screen.getByRole("button", { name: "Browser resolution: 1920x1080" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close all tabs" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Close all tabs" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Close all tabs" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Browser resolution: 1920x1080" })).toBeEnabled(),
    );
    expect(screen.getByRole("button", { name: "Browser resolution: 1920x1080" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Browser resolution: 1920x1080" }));
    await user.click(screen.getByRole("menuitemradio", { name: "1280 × 800" }));
    await user.type(screen.getByRole("textbox", { name: "Page address" }), "example.test{Enter}");
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/sessions",
        expect.objectContaining({
          body: JSON.stringify({ browserType: "chromium", resolution: "1280x800" }),
        }),
      ),
    );
  });

  it("keeps the browser and address after a navigation failure so the user can retry", async () => {
    let attempts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
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
            resolution: "1280x800",
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
