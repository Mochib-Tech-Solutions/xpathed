import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { mockSystemTheme } from "@/test/systemTheme";
import { ThemeProvider } from "../theme/ThemeProvider";
import Workspace from "./Workspace";
import useWorkspace from "./useWorkspace";
import type { ResolutionResult, SessionState } from "./api";

vi.mock("./BrowserViewer", () => ({ default: () => <div aria-label="Managed browser" /> }));

function foundResult(action = "click"): ResolutionResult {
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

async function setup(
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
  mockSystemTheme();
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

it("executes only on explicit click and invalidates every result while the request is pending", async () => {
  let finish!: (response: Response) => void;
  const user = await setup(
    "click",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  expect(vi.mocked(fetch).mock.calls.some(([path]) => path === "/api/pages/page/execute")).toBe(
    false,
  );
  await user.type(screen.getByRole("textbox", { name: "Describe an element" }), "keep my draft");
  await user.click(screen.getByRole("button", { name: "Execute click on target 1" }));
  expect(fetch).toHaveBeenCalledWith(
    "/api/pages/page/execute",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        sessionId: "session",
        documentId: "document",
        captureId: "capture",
        actionId: "a1",
      }),
    }),
  );
  expect(screen.queryByRole("button", { name: /Execute click/ })).not.toBeInTheDocument();
  expect(screen.getByText("Earlier result")).toBeVisible();
  expect(screen.getByRole("button", { name: "Resolve instruction" })).toBeDisabled();
  finish(
    Response.json({
      actionId: "a1",
      action: "click",
      status: "completed",
      message: "Browser action completed. Check the page for the result.",
    }),
  );
  expect(
    await screen.findByText("Browser action completed. Check the page for the result."),
  ).toBeVisible();
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled(),
  );
  expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue("keep my draft");
  expect(
    vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/pages/page/resolve"),
  ).toHaveLength(1);
});

it("sends explicitly entered values only to execution and clears their field after dispatch", async () => {
  const user = await setup("fill");
  await user.type(
    screen.getByRole("textbox", { name: "Value to enter for target 1" }),
    "synthetic-private-value",
  );
  await user.click(screen.getByRole("button", { name: "Execute fill on target 1" }));
  await screen.findByText("Browser action completed. Check the page for the result.");
  expect(
    screen.queryByRole("textbox", { name: "Value to enter for target 1" }),
  ).not.toBeInTheDocument();
  const calls = vi.mocked(fetch).mock.calls;
  const execution = calls.find(([path]) => path === "/api/pages/page/execute");
  expect(JSON.parse(execution![1]!.body as string)).toEqual(
    expect.objectContaining({ value: "synthetic-private-value" }),
  );
  expect(
    calls
      .filter(([path]) => path === "/api/pages/page/resolve")
      .every(
        ([, init]) =>
          typeof init?.body === "string" && !init.body.includes("synthetic-private-value"),
      ),
  ).toBe(true);
  expect(screen.queryByText("synthetic-private-value")).not.toBeInTheDocument();
});

it.each([409, 502])("retains execution failure %s without offering replay", async (status) => {
  const user = await setup("click", () =>
    Promise.resolve(
      Response.json({ message: "The target is no longer ready. Resolve it again." }, { status }),
    ),
  );
  await user.click(screen.getByRole("button", { name: "Execute click on target 1" }));
  const message =
    status === 409
      ? "The target is no longer ready. Resolve it again."
      : "The browser could not confirm completion. Check the page before resolving again.";
  expect(await screen.findByText(message)).toBeVisible();
  expect(screen.queryByRole("button", { name: /Execute click/ })).not.toBeInTheDocument();
  expect(
    vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/pages/page/execute"),
  ).toHaveLength(1);
});

it("does not offer execution for a historical result after a new resolution", async () => {
  const user = await setup();
  await user.type(screen.getByRole("textbox", { name: "Describe an element" }), "Click Save");
  await user.click(screen.getByRole("button", { name: "Resolve instruction" }));
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Execute click on target 1" })).toHaveLength(1),
  );
  expect(screen.getByText("Earlier result")).toBeVisible();
});

async function lifecycle() {
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

it("keeps initial and per-tab settings through navigation and reset, with fresh-tab defaults", async () => {
  const run = await lifecycle();
  expect(run.result.current.autoExecute).toBe(false);
  expect(run.result.current.imageMode).toBe("auto");
  act(() => {
    run.result.current.setAutoExecute(true);
    run.result.current.setImageMode("text_only");
  });
  await run.open();
  expect(run.result.current.autoExecute).toBe(true);
  expect(run.result.current.imageMode).toBe("text_only");
  act(() => run.result.current.resetChat());
  await run.open();
  expect(run.result.current.autoExecute).toBe(true);
  expect(run.result.current.imageMode).toBe("text_only");
  act(() => run.result.current.newTab());
  await waitFor(() => expect(run.result.current.page?.pageId).toBe("page2"));
  await waitFor(() => expect(run.result.current.busy).toBe(""));
  expect(run.result.current.autoExecute).toBe(false);
  expect(run.result.current.imageMode).toBe("auto");
  act(() => run.result.current.selectTab("page"));
  await waitFor(() => expect(run.result.current.page?.pageId).toBe("page"));
  expect(run.result.current.autoExecute).toBe(true);
  expect(run.result.current.imageMode).toBe("text_only");
  expect(run.requests("/pages/page/execute")).toHaveLength(0);
});

it("executes once inside the resolving operation and keeps settings and another request locked", async () => {
  const run = await lifecycle();
  act(() => run.result.current.setAutoExecute(true));
  await run.open();
  let finish!: (value: Response) => void;
  run.setExecuteResponse(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => run.result.current.resolve("Click Save"));
  await waitFor(() => expect(run.result.current.busy).toBe("Executing…"));
  expect(run.requests("/pages/page/execute")).toHaveLength(1);
  expect(run.result.current.history[0]).toMatchObject({
    historical: true,
    execution: { status: "pending" },
  });
  act(() => {
    run.result.current.resolve("Click again");
    run.result.current.setAutoExecute(false);
    run.result.current.setImageMode("text_only");
  });
  expect(run.requests("/pages/page/resolve")).toHaveLength(1);
  expect(run.result.current.autoExecute).toBe(true);
  expect(run.result.current.imageMode).toBe("auto");
  await act(() =>
    Promise.resolve(
      finish(
        Response.json({
          actionId: "a1",
          action: "click",
          status: "completed",
          message: "Completed once.",
        }),
      ),
    ),
  );
  await waitFor(() => expect(run.result.current.busy).toBe(""));
  expect(run.result.current.history[0]?.execution?.status).toBe("completed");
  run.rerender();
  expect(run.requests("/pages/page/execute")).toHaveLength(1);
});

it("does not execute old results when enabled, and retries only the newly resolved capture", async () => {
  const run = await lifecycle();
  await run.open();
  await run.resolve();
  expect(run.requests("/pages/page/execute")).toHaveLength(0);
  act(() => run.result.current.setAutoExecute(true));
  run.rerender();
  expect(run.requests("/pages/page/execute")).toHaveLength(0);
  run.setResult({ ...foundResult(), captureId: "fresh-capture" });
  await run.resolve();
  expect(run.requests("/pages/page/execute")).toHaveLength(1);
  expect(JSON.parse(run.requests("/pages/page/execute")[0]![1]!.body as string)).toEqual({
    sessionId: "session",
    documentId: "document",
    captureId: "fresh-capture",
    actionId: "a1",
  });
  expect(run.result.current.history[0]?.execution).toBeUndefined();
  expect(run.result.current.history[1]?.execution?.status).toBe("completed");
});

it.each(["fill", "type", "select", "press", "inspect"])(
  "leaves %s for manual handling",
  async (action) => {
    const run = await lifecycle();
    await run.open();
    act(() => run.result.current.setAutoExecute(true));
    run.setResult(foundResult(action));
    await run.resolve();
    expect(run.requests("/pages/page/execute")).toHaveLength(0);
  },
);

it.each(["blocked", "unknown", "unsupported"] as const)(
  "does not auto-execute %s readiness",
  async (status) => {
    const run = await lifecycle();
    await run.open();
    act(() => run.result.current.setAutoExecute(true));
    const result = foundResult();
    result.actions![0]!.target!.interactability!.status = status;
    run.setResult(result);
    await run.resolve();
    expect(run.requests("/pages/page/execute")).toHaveLength(0);
  },
);

it.each([
  "multiple",
  "partial",
  "incomplete",
  "ambiguous",
  "wrong-session",
  "wrong-page",
  "wrong-document",
  "missing-capture",
])("does not auto-execute a %s result", async (kind) => {
  const run = await lifecycle();
  await run.open();
  act(() => run.result.current.setAutoExecute(true));
  const result = foundResult();
  if (kind === "multiple")
    result.actions!.push({ ...result.actions![0]!, actionId: "a2", order: 2 });
  if (kind === "partial") result.outcome = "partial";
  if (kind === "incomplete") result.summary!.processingComplete = false;
  if (kind === "ambiguous") {
    result.outcome = "unsupported";
    result.actions = [];
    result.diagnostics.code = "ambiguous_target";
  }
  if (kind === "wrong-session") result.sessionId = "other";
  if (kind === "wrong-page") result.pageId = "other";
  if (kind === "wrong-document") result.documentId = "other";
  if (kind === "missing-capture") result.captureId = null;
  run.setResult(result);
  await run.resolve();
  expect(run.requests("/pages/page/execute")).toHaveLength(0);
});

it.each(["activation", "page", "document", "session", "refresh-failure"])(
  "requires a fresh matching session after resolution: %s",
  async (kind) => {
    const run = await lifecycle();
    await run.open();
    act(() => run.result.current.setAutoExecute(true));
    run.setResolveResponse(() => {
      if (kind === "activation") run.setSnapshot({ activationVersion: 3 });
      if (kind === "page") run.setSnapshot({ activePageId: "other" });
      if (kind === "document") run.setSnapshot({ pages: [] });
      if (kind === "session") run.setSnapshot({ sessionId: "other" });
      if (kind === "refresh-failure")
        run.setSessionResponse(() =>
          Promise.resolve(Response.json({ message: "Refresh failed." }, { status: 502 })),
        );
      return Promise.resolve(Response.json(foundResult()));
    });
    await run.resolve();
    expect(run.requests("/pages/page/execute")).toHaveLength(0);
  },
);

it("never dispatches a late resolution after unmount", async () => {
  const run = await lifecycle();
  await run.open();
  act(() => run.result.current.setAutoExecute(true));
  let finish!: (value: Response) => void;
  run.setResolveResponse(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => run.result.current.resolve("Click Save"));
  run.unmount();
  await act(() => Promise.resolve(finish(Response.json(foundResult()))));
  expect(run.requests("/pages/page/execute")).toHaveLength(0);
});

it.each([404, 502])("does not auto-execute after session polling fails with %s", async (status) => {
  const run = await lifecycle();
  await run.open();
  act(() => run.result.current.setAutoExecute(true));
  let finish!: (value: Response) => void;
  run.setResolveResponse(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => run.result.current.resolve("Click Save"));
  run.setSessionResponse(() =>
    Promise.resolve(Response.json({ message: "Session unavailable." }, { status })),
  );
  await waitFor(
    () =>
      expect(status === 404 ? run.result.current.error : run.result.current.pollError).not.toBe(""),
    { timeout: 3000 },
  );
  run.resetSessionResponse();
  await act(() => Promise.resolve(finish(Response.json(foundResult()))));
  await waitFor(() => expect(run.result.current.busy).toBe(""));
  expect(run.requests("/pages/page/execute")).toHaveLength(0);
});

it.each([409, 502])(
  "never retries an automatic action after execution failure %s",
  async (status) => {
    const run = await lifecycle();
    await run.open();
    act(() => run.result.current.setAutoExecute(true));
    run.setExecuteResponse(() =>
      Promise.resolve(Response.json({ message: "Unavailable." }, { status })),
    );
    await run.resolve();
    expect(run.result.current.history[0]).toMatchObject({
      historical: true,
      execution: { status: status === 409 ? "failed" : "uncertain" },
    });
    act(() => {
      run.result.current.setAutoExecute(false);
      run.result.current.setAutoExecute(true);
    });
    run.rerender();
    expect(run.requests("/pages/page/execute")).toHaveLength(1);
  },
);
