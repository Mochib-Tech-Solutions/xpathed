import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { foundResult, lifecycle } from "./workspaceExecutionTestUtils";

vi.mock("./BrowserViewer", () => ({ default: () => <div aria-label="Managed browser" /> }));
describe("Workspace auto-execution", () => {
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

  it.each([404, 502])(
    "does not auto-execute after session polling fails with %s",
    async (status) => {
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
          expect(status === 404 ? run.result.current.error : run.result.current.pollError).not.toBe(
            "",
          ),
        { timeout: 3000 },
      );
      run.resetSessionResponse();
      await act(() => Promise.resolve(finish(Response.json(foundResult()))));
      await waitFor(() => expect(run.result.current.busy).toBe(""));
      expect(run.requests("/pages/page/execute")).toHaveLength(0);
    },
  );

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
});
