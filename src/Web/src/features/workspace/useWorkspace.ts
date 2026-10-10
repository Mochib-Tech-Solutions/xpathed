import {
  type Settings,
  emptyWorkspace,
  emptyChat,
  historical,
  updateSession,
  completeResolution,
  recordExecution,
  updateChat,
} from "./workspaceState";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, request } from "./api";
import { canExecute, needsExecutionValue } from "./actionExecution";
import type {
  ActionExecutionResult,
  BrowserSessionOptions,
  ImageMode,
  PageState,
  Resolution,
  ResolutionResult,
  Session,
  SessionState,
} from "./api";

export default function useWorkspace() {
  const [browserOptions, setBrowserOptions] = useState<BrowserSessionOptions | null>(null);
  const [resolution, setResolution] = useState("1280x800");
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const { session, snapshot, tabs } = workspace;
  const page = snapshot?.pages.find((entry) => entry.pageId === snapshot.activePageId) ?? null;
  const chat = page
    ? (tabs[page.pageId] ?? emptyChat)
    : { ...emptyChat, ...workspace.initialSettings };
  const [busy, setBusy] = useState("");
  const [addressFocus, setAddressFocus] = useState(0);
  const closing = busy === "Closing tabs…";
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const pending = useRef(false);
  const revision = useRef(0);
  const snapshotRevision = useRef(0);
  const spotlightQueue = useRef(Promise.resolve());
  const observedSnapshot = useRef<SessionState | null>(null);
  const executionRevision = useRef(0);
  const applySnapshot = useCallback((next: SessionState) => {
    const previous = observedSnapshot.current;
    if (
      previous &&
      (previous.sessionId !== next.sessionId ||
        previous.activePageId !== next.activePageId ||
        previous.activationVersion !== next.activationVersion ||
        previous.pages.find((item) => item.pageId === previous.activePageId)?.documentId !==
          next.pages.find((item) => item.pageId === next.activePageId)?.documentId)
    )
      executionRevision.current += 1;
    observedSnapshot.current = next;
    snapshotRevision.current += 1;
    setWorkspace((previous) => updateSession(previous, next));
  }, []);

  useEffect(() => {
    let active = true;
    void request<BrowserSessionOptions>("/sessions/options")
      .then((options) => {
        if (active) {
          setBrowserOptions(options);
          setResolution(options.defaultResolution);
        }
      })
      .catch(() => {
        if (active) setError("Unable to load browser choices. Reload the app to try again.");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(
    () => () => {
      revision.current += 1;
      pending.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!session) return;
    const close = () => {
      void fetch(`/api/sessions/${session.sessionId}`, { method: "DELETE", keepalive: true }).catch(
        () => undefined,
      );
    };
    window.addEventListener("pagehide", close);
    return () => window.removeEventListener("pagehide", close);
  }, [session]);

  useEffect(() => {
    if (!session || closing) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const startedAt = revision.current;
      const snapshotAt = snapshotRevision.current;
      const isCurrent = () =>
        active && revision.current === startedAt && snapshotRevision.current === snapshotAt;
      try {
        const next = await request<SessionState>(`/sessions/${session!.sessionId}`);
        if (!isCurrent()) return;
        applySnapshot(next);
        setPollError("");
      } catch (failure) {
        if (!isCurrent()) return;
        executionRevision.current += 1;
        if (failure instanceof ApiError && failure.status === 404) {
          active = false;
          revision.current += 1;
          pending.current = false;
          setWorkspace(emptyWorkspace);
          setBusy("");
          setError("Your browser session has ended. Enter a website address to start again.");
          setPollError("");
        } else setPollError("Unable to refresh the tabs. Retrying…");
      } finally {
        if (active)
          timer = setTimeout(() => {
            void refresh();
          }, 2000);
      }
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [session, closing, applySnapshot]);

  async function perform(label: string, action: (isCurrent: () => boolean) => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    const startedAt = ++revision.current;
    snapshotRevision.current += 1;
    const isCurrent = () => revision.current === startedAt;
    setBusy(label);
    setError("");
    setPollError("");
    try {
      await action(isCurrent);
    } catch (failure) {
      if (isCurrent())
        setError(
          failure instanceof Error ? failure.message : "Something went wrong. Please try again.",
        );
    } finally {
      if (isCurrent()) {
        pending.current = false;
        setBusy("");
      }
    }
  }

  async function readSession(id: string, isCurrent: () => boolean) {
    const next = await request<SessionState>(`/sessions/${id}`);
    if (isCurrent()) applySnapshot(next);
    return next;
  }
  function closeAllTabs() {
    if (!session) return;
    void perform("Closing tabs…", async (isCurrent) => {
      await request(`/sessions/${session.sessionId}`, "DELETE");
      if (isCurrent()) setWorkspace(emptyWorkspace);
    });
  }
  function navigate(url: string) {
    if (!session && !browserOptions) return;
    void perform("Opening website…", async (isCurrent) => {
      const currentSession =
        session ??
        (await request<Session>("/sessions", "POST", { browserType: "chromium", resolution }));
      if (!isCurrent()) return;
      const pageId = page?.pageId ?? currentSession.pageId;
      setWorkspace((previous) => ({
        ...previous,
        session: currentSession,
        tabs: {
          ...previous.tabs,
          [pageId]: {
            ...(previous.tabs[pageId] ?? { ...emptyChat, ...previous.initialSettings }),
            address: previous.tabs[pageId]?.address ?? previous.initialAddress,
            history: historical(previous.tabs[pageId]?.history ?? []),
          },
        },
      }));
      try {
        await request<PageState>(`/pages/${pageId}/navigate`, "POST", { url });
      } finally {
        if (isCurrent()) await readSession(currentSession.sessionId, isCurrent);
      }
    });
  }
  function newTab() {
    if (!session) return;
    void perform("Opening tab…", async (isCurrent) => {
      const next = await request<SessionState>(`/sessions/${session.sessionId}/pages`, "POST");
      if (isCurrent()) {
        applySnapshot(next);
        setAddressFocus((previous) => previous + 1);
      }
    });
  }
  function selectTab(pageId: string) {
    if (pageId === page?.pageId) return;
    void perform("Switching tab…", async (isCurrent) => {
      const next = await request<SessionState>(`/pages/${pageId}/activate`, "POST");
      if (isCurrent()) applySnapshot(next);
    });
  }
  function closeTab(pageId: string) {
    void perform("Closing tab…", async (isCurrent) => {
      const next = await request<SessionState>(`/pages/${pageId}`, "DELETE");
      if (isCurrent()) applySnapshot(next);
    });
  }
  function resolve(instruction?: string) {
    const text = (instruction ?? chat.instruction).trim();
    if (!session || !page || !text || text.length > 4000) return;
    const entry: Resolution = {
      id: crypto.randomUUID(),
      instruction: text,
      createdAt: new Date().toISOString(),
      respondedAt: null,
      pageUrl: page.url,
      pageTitle: page.title,
      documentId: page.documentId,
      historical: false,
      result: null,
      error: null,
    };
    void perform("Resolving…", async (isCurrent) => {
      const executionAt = executionRevision.current;
      setWorkspace((previous) => ({
        ...previous,
        tabs: {
          ...previous.tabs,
          [page.pageId]: {
            ...previous.tabs[page.pageId]!,
            instruction: instruction === undefined ? "" : previous.tabs[page.pageId]!.instruction,
            history: [...historical(previous.tabs[page.pageId]!.history), entry],
          },
        },
      }));
      let result: ResolutionResult | null = null;
      let failure: string | null = null;
      let freshSession: SessionState | null = null;
      try {
        result = await request<ResolutionResult>(`/pages/${page.pageId}/resolve`, "POST", {
          instruction: text,
          documentId: page.documentId,
          imageMode: chat.imageMode,
        });
        if (!isCurrent()) return;
        freshSession = await readSession(session.sessionId, isCurrent);
        if (
          result.pageId !== page.pageId ||
          result.documentId !== page.documentId ||
          (result.sessionId !== null && result.sessionId !== session.sessionId)
        ) {
          result = null;
          failure = "The page changed. Resolve the instruction again.";
        }
      } catch (caught) {
        failure = caught instanceof Error ? caught.message : "Resolution failed. Please try again.";
      }
      if (!isCurrent()) return;
      const respondedAt = new Date().toISOString();
      setWorkspace((previous) =>
        completeResolution(
          previous,
          page,
          snapshot?.activationVersion,
          entry.id,
          result,
          failure,
          respondedAt,
        ),
      );
      const action = result?.actions?.[0];
      const resolvedEntry = { ...entry, result, respondedAt };
      if (
        chat.autoExecute &&
        !failure &&
        result?.outcome === "found" &&
        result.sessionId === session.sessionId &&
        result.actions?.length === 1 &&
        result.summary?.processingComplete === true &&
        result.summary.total === 1 &&
        result.summary.found === 1 &&
        action &&
        result.action === action.action &&
        action.target?.interactability?.status === "ready" &&
        canExecute(resolvedEntry, action) &&
        !needsExecutionValue(action.action) &&
        freshSession?.sessionId === session.sessionId &&
        freshSession.activePageId === page.pageId &&
        freshSession.activationVersion === snapshot?.activationVersion &&
        freshSession.pages.some(
          (current) => current.pageId === page.pageId && current.documentId === page.documentId,
        ) &&
        executionRevision.current === executionAt &&
        isCurrent()
      ) {
        setBusy("Executing…");
        await executeResolved(resolvedEntry, action.actionId, isCurrent);
      }
    });
  }
  function spotlight(entry: Resolution, actionId: string | null) {
    const result = entry.result;
    if (
      pending.current ||
      entry.historical ||
      !result?.captureId ||
      result.pageId !== page?.pageId ||
      result.documentId !== page.documentId
    )
      return;
    const startedAt = revision.current;
    const snapshotAt = snapshotRevision.current;
    spotlightQueue.current = spotlightQueue.current.then(async () => {
      if (
        pending.current ||
        revision.current !== startedAt ||
        snapshotRevision.current !== snapshotAt
      )
        return;
      try {
        await request(`/pages/${result.pageId}/spotlight`, "POST", {
          documentId: result.documentId,
          captureId: result.captureId,
          actionId,
        });
      } catch (failure) {
        if (revision.current === startedAt && snapshotRevision.current === snapshotAt) {
          setError(failure instanceof Error ? failure.message : "Unable to spotlight this target.");
        }
      }
    });
  }
  function execute(entry: Resolution, actionId: string, value?: string) {
    const result = entry.result;
    const action = result?.actions?.find((action) => action.actionId === actionId);
    if (
      !action ||
      !canExecute(entry, action) ||
      !result ||
      !session ||
      !page ||
      result.pageId !== page.pageId ||
      result.documentId !== page.documentId ||
      result.sessionId !== session.sessionId
    )
      return;
    void perform("Executing…", (isCurrent) => executeResolved(entry, actionId, isCurrent, value));
  }
  async function executeResolved(
    entry: Resolution,
    actionId: string,
    isCurrent: () => boolean,
    value?: string,
  ) {
    const result = entry.result;
    if (!session || !page || !result?.captureId || !isCurrent()) return;
    function updateExecution(execution: NonNullable<Resolution["execution"]>) {
      setWorkspace((previous) =>
        recordExecution(previous, page!.pageId, session!.sessionId, entry.id, execution),
      );
    }
    updateExecution({ actionId, status: "pending", message: "Executing…" });
    try {
      const execution = await request<ActionExecutionResult>(
        `/pages/${page.pageId}/execute`,
        "POST",
        {
          sessionId: session.sessionId,
          documentId: result.documentId,
          captureId: result.captureId,
          actionId,
          ...(value === undefined ? {} : { value }),
        },
      );
      if (!isCurrent()) return;
      if (execution.actionId !== actionId || !["completed", "uncertain"].includes(execution.status))
        throw new Error(
          "The browser could not confirm completion. Check the page before resolving again.",
        );
      updateExecution(execution);
    } catch (failure) {
      if (!isCurrent()) return;
      const rejected = failure instanceof ApiError && failure.status >= 400 && failure.status < 500;
      updateExecution({
        actionId,
        status: rejected ? "failed" : "uncertain",
        message: rejected
          ? failure.message
          : "The browser could not confirm completion. Check the page before resolving again.",
      });
    } finally {
      if (isCurrent()) await readSession(session.sessionId, isCurrent);
    }
  }
  function setInstruction(instruction: string) {
    if (page) setWorkspace((previous) => updateChat(previous, page.pageId, { instruction }));
  }
  function resetChat() {
    if (!page || pending.current) return;
    const latest = chat.history.at(-1);
    if (latest) spotlight(latest, null);
    setWorkspace((previous) => updateChat(previous, page.pageId, { instruction: "", history: [] }));
  }
  function setAddress(address: string) {
    setWorkspace((previous) =>
      page
        ? updateChat(previous, page.pageId, { address })
        : { ...previous, initialAddress: address },
    );
  }
  function setSettings(settings: Partial<Settings>) {
    if (pending.current) return;
    setWorkspace((previous) =>
      page
        ? updateChat(previous, page.pageId, settings)
        : { ...previous, initialSettings: { ...previous.initialSettings, ...settings } },
    );
  }
  return {
    session,
    resolution: session?.resolution ?? resolution,
    setResolution: (next: string) => {
      if (
        !session &&
        !pending.current &&
        browserOptions?.resolutions.some((choice) => choice.id === next)
      )
        setResolution(next);
    },
    browserOptions,
    page,
    pages: snapshot?.pages ?? [],
    address: page ? chat.address : workspace.initialAddress,
    addressFocus,
    instruction: chat.instruction,
    imageMode: chat.imageMode,
    setImageMode: (imageMode: ImageMode) => setSettings({ imageMode }),
    autoExecute: chat.autoExecute,
    setAutoExecute: (autoExecute: boolean) => setSettings({ autoExecute }),
    history: chat.history,
    busy,
    error,
    pollError,
    resolving: busy === "Resolving…" && chat.history.some((entry) => !entry.result && !entry.error),
    closeAllTabs,
    navigate,
    newTab,
    selectTab,
    closeTab,
    resolve,
    setInstruction,
    resetChat,
    spotlight,
    execute,
    setAddress,
    dismissError: () => setError(""),
  };
}
