import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, vi } from "vitest";
import { ThemeProvider } from "../theme/ThemeProvider";
import Workspace from "./Workspace";

export const session = {
  sessionId: "session-1",
  pageId: "page-1",
  viewPath: "/view/page-1",
  browserType: "chromium" as const,
  resolution: "1280x800",
};

export const page = {
  ...session,
  documentId: "document-1",
  url: "https://example.test/checkout",
  title: "Checkout",
  blockedPopups: 0,
};

export const target = {
  candidateId: "candidate-1",
  tag: "button",
  label: "Pay now",
  xpaths: ["//*[@data-testid='pay']", "//button[normalize-space(.)='Pay now']"],
  state: { rendered: true, inViewport: false, enabled: false, editable: false, checked: null },
  geometry: { x: 20, y: 1200, width: 100, height: 40 },
};

export const found = {
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
  target: null,
  actions: [
    {
      actionId: "a1",
      order: 1,
      instruction: "Click Pay now",
      action: "click",
      outcome: "found",
      target,
    },
  ],
  diagnostics: { code: null, message: null },
};

export function renderWorkspace() {
  return render(
    <ThemeProvider>
      <Workspace />
    </ThemeProvider>,
  );
}

export function mockApi(
  resolve = () => Promise.resolve(Response.json(found)),
  currentPage = () => page,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>((input, options) => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (options?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      if (path === "/api/sessions/options")
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
      if (path === "/api/sessions") return Promise.resolve(Response.json(session));
      if (path === "/api/sessions/session-1")
        return Promise.resolve(
          Response.json({
            sessionId: session.sessionId,
            activePageId: page.pageId,
            activationVersion: 1,
            viewPath: session.viewPath,
            browserType: "chromium" as const,
            resolution: "1280x800",
            pages: [currentPage()],
          }),
        );
      if (path.endsWith("/resolve")) return resolve();
      return Promise.resolve(Response.json(currentPage()));
    }),
  );
}

export async function openWorkspace() {
  const user = userEvent.setup();
  renderWorkspace();
  await user.type(screen.getByRole("textbox", { name: "Page address" }), `${page.url}{Enter}`);
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled(),
  );
  return user;
}

export async function submitInstruction(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("textbox", { name: "Describe an element" }), "Click Pay now");
  await user.click(screen.getByRole("button", { name: "Resolve instruction" }));
}
