import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, vi } from "vitest";
import { ThemeProvider } from "../theme/ThemeProvider";
import Workspace from "./Workspace";
import useWorkspace from "./useWorkspace";
import type { ResolutionResult, SessionState } from "./api";

export function foundResult(action = "click"): ResolutionResult {
  return {
    outcome: "found",
    sessionId: "session",
    pageId: "page",
    documentId: "document",
    captureId: "capture",
    frameId: null,
    traceId: "trace",
    attemptId: "attempt",
    configurationId: "configuration",
    action,
    target: null,
    diagnostics: { code: null, message: null },
    summary: {
      processingComplete: true,
      semanticCompleteness: "unverified",
      total: 1,
      found: 1,
      notFound: 0,
      unsupported: 0,
      errors: 0,
      blocked: 0,
      readinessUnknown: 0,
      assessmentUnsupported: 0,
    },
    actions: [
      {
        actionId: "a1",
        order: 1,
        step: 1,
        frameId: "main",
        diagnosticsReference: "diagnostics",
        code: null,
        message: null,
        action,
        instruction: "Click Save",
        outcome: "found",
        target: {
          candidateId: "c1",
          tag: action === "fill" ? "input" : "button",
          label: "Save",
          xpaths: ["//button[@id='save']"],
          geometry: { x: 0, y: 0, width: 100, height: 30 },
          state: {
            rendered: true,
            inViewport: true,
            enabled: true,
            editable: action === "fill",
            checked: null,
          },
          interactability: {
            action,
            status: "ready",
            reasons: [],
            checks: {
              compatibleControl: "pass",
              enabled: "pass",
              keyboard: "pass",
              viewport: "pass",
              pointerReception: "pass",
            },
          },
        },
      },
    ],
  };
}

export async function setup(
  action = "click",
  execute = () =>
    Promise.resolve(
      Response.json({
        actionId: "a1",
        action,
        status: "completed",
        message: "Browser action completed. Check the page for the result.",
      }),
    ),
) {
  const session = {
    sessionId: "session",
    pageId: "page",
    viewPath: "/view/session",
    browserType: "chromium",
    resolution: "1280x800",
  };
  const page = {
    ...session,
    documentId: "document",
    url: "https://example.test",
    title: "Test",
    blockedPopups: 0,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      if (input === "/api/sessions/options")
        return Response.json({
          defaultBrowserType: "chromium",
          browserTypes: ["chromium"],
          defaultResolution: "1280x800",
          resolutions: [{ id: "1280x800", width: 1280, height: 800 }],
        });
      if (input === "/api/sessions") return Response.json(session);
      if (input === "/api/sessions/session")
        return Response.json({
          ...session,
          activePageId: "page",
          activationVersion: 1,
          pages: [page],
        });
      if (input === "/api/pages/page/execute") return execute();
      if (input === "/api/pages/page/resolve") return Response.json(foundResult(action));
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json(page);
    }),
  );
  const user = userEvent.setup();
  render(
    <ThemeProvider>
      <Workspace />
    </ThemeProvider>,
  );
  await user.type(
    screen.getByRole("textbox", { name: "Page address" }),
    "https://example.test{Enter}",
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled(),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Describe an element" }),
    action === "fill" ? "Fill Save" : "Click Save",
  );
  await user.click(screen.getByRole("button", { name: "Resolve instruction" }));
  await screen.findByRole("button", { name: `Execute ${action} on target 1` });
  return user;
}

export async function lifecycle() {
  const session = {
    sessionId: "session",
    pageId: "page",
    viewPath: "/view/session",
    browserType: "chromium" as const,
    resolution: "1280x800",
  };
  const page = {
    ...session,
    documentId: "document",
    url: "https://example.test",
    title: "Test",
    blockedPopups: 0,
  };
  let snapshot: SessionState = {
    ...session,
    activePageId: "page",
    activationVersion: 1,
    pages: [page],
  };
  let resolveResult = foundResult();
  let resolveResponse = () => Promise.resolve(Response.json(resolveResult));
  let sessionResponse = () => Promise.resolve(Response.json(snapshot));
  let executeResponse = () =>
    Promise.resolve(
      Response.json({
        actionId: "a1",
        action: "click",
        status: "completed",
        message: "Completed once.",
      }),
    );
  const provider = vi.fn<typeof fetch>(async (input, init) => {
    if (input === "/api/sessions/options")
      return Response.json({
        defaultBrowserType: "chromium",
        browserTypes: ["chromium"],
        defaultResolution: "1280x800",
        resolutions: [{ id: "1280x800", width: 1280, height: 800 }],
      });
    if (input === "/api/sessions") return Response.json(session);
    if (input === "/api/sessions/session") return sessionResponse();
    if (input === "/api/pages/page/resolve") return resolveResponse();
    if (input === "/api/pages/page/execute") return executeResponse();
    if (input === "/api/sessions/session/pages") {
      snapshot = {
        ...snapshot,
        activePageId: "page2",
        activationVersion: 2,
        pages: [page, { ...page, pageId: "page2" }],
      };
      return Response.json(snapshot);
    }
    if (input === "/api/pages/page/activate") {
      snapshot = { ...snapshot, activePageId: "page", activationVersion: 3 };
      return Response.json(snapshot);
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json(page);
  });
  vi.stubGlobal("fetch", provider);
  const hook = renderHook(useWorkspace);
  await waitFor(() => expect(hook.result.current.browserOptions).not.toBeNull());
  return {
    ...hook,
    requests: (path: string) => provider.mock.calls.filter(([url]) => url === `/api${path}`),
    setResult: (next: ResolutionResult) => {
      resolveResult = next;
    },
    setSnapshot: (next: Partial<SessionState>) => {
      snapshot = { ...snapshot, ...next };
    },
    setResolveResponse: (next: typeof resolveResponse) => {
      resolveResponse = next;
    },
    setSessionResponse: (next: typeof sessionResponse) => {
      sessionResponse = next;
    },
    resetSessionResponse: () => {
      sessionResponse = () => Promise.resolve(Response.json(snapshot));
    },
    setExecuteResponse: (next: typeof executeResponse) => {
      executeResponse = next;
    },
    async open() {
      act(() => hook.result.current.navigate("https://example.test"));
      await waitFor(() => expect(hook.result.current.page?.pageId).toBe("page"));
      await waitFor(() => expect(hook.result.current.busy).toBe(""));
    },
    async resolve() {
      act(() => hook.result.current.resolve("Click Save"));
      await waitFor(() => expect(hook.result.current.busy).toBe(""));
    },
  };
}
