import { useEffect, useRef, useState } from "react";
import { ApiError, request } from "./api";
import type { PageState, Resolution, ResolutionResult, Session, SessionState } from "./api";

type TabChat = { address: string; instruction: string; history: Resolution[] };
type WorkspaceState = {
  session: Session | null;
  snapshot: SessionState | null;
  tabs: Record<string, TabChat>;
  initialAddress: string;
};
const emptyWorkspace: WorkspaceState = {
  session: null,
  snapshot: null,
  tabs: {},
  initialAddress: "",
};
const emptyChat: TabChat = { address: "", instruction: "", history: [] };
const pageAddress = (page: PageState) => (page.url === "about:blank" ? "" : page.url);
const historical = (entries: Resolution[]) =>
  entries.map((entry) => (entry.historical ? entry : { ...entry, historical: true }));

function updateSession(previous: WorkspaceState, snapshot: SessionState): WorkspaceState {
  if (previous.session?.sessionId !== snapshot.sessionId) return previous;
  const tabs: Record<string, TabChat> = {};
  for (const page of snapshot.pages) {
    const chat = previous.tabs[page.pageId];
    const oldPage = previous.snapshot?.pages.find((old) => old.pageId === page.pageId);
    const leftPage =
      previous.snapshot?.activePageId === page.pageId &&
      (snapshot.activePageId !== page.pageId ||
        snapshot.activationVersion !== previous.snapshot.activationVersion);
    tabs[page.pageId] = chat
      ? {
          ...chat,
          address:
            oldPage?.url !== page.url && (oldPage !== undefined || page.url !== "about:blank")
              ? pageAddress(page)
              : chat.address,
          history:
            leftPage || oldPage?.documentId !== page.documentId
              ? historical(chat.history)
              : chat.history,
        }
      : { ...emptyChat, address: pageAddress(page) };
  }
  return { ...previous, snapshot, tabs };
}

export default function useWorkspace() {
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const { session, snapshot, tabs } = workspace;
  const page = snapshot?.pages.find((entry) => entry.pageId === snapshot.activePageId) ?? null;
  const chat = page ? (tabs[page.pageId] ?? emptyChat) : emptyChat;
  const [busy, setBusy] = useState("");
  const [addressFocus, setAddressFocus] = useState(0);
  const closing = busy === "Closing tabs…";
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const pending = useRef(false);
  const revision = useRef(0);
  const snapshotRevision = useRef(0);
  const spotlightQueue = useRef(Promise.resolve());

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
        setWorkspace((previous) => updateSession(previous, next));
        setPollError("");
      } catch (failure) {
        if (!isCurrent()) return;
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
  }, [session, closing]);

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

  function applySnapshot(next: SessionState) {
    snapshotRevision.current += 1;
    setWorkspace((previous) => updateSession(previous, next));
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
    void perform("Opening website…", async (isCurrent) => {
      const currentSession = session ?? (await request<Session>("/sessions", "POST"));
      if (!isCurrent()) return;
      const pageId = page?.pageId ?? currentSession.pageId;
      setWorkspace((previous) => ({
        ...previous,
        session: currentSession,
        tabs: {
          ...previous.tabs,
          [pageId]: {
            ...(previous.tabs[pageId] ?? emptyChat),
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
      try {
        result = await request<ResolutionResult>(`/pages/${page.pageId}/resolve`, "POST", {
          instruction: text,
          documentId: page.documentId,
        });
        if (!isCurrent()) return;
        await readSession(session.sessionId, isCurrent);
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
      setWorkspace((previous) => {
        const origin = previous.tabs[page.pageId];
        if (!origin) return previous;
        const currentPage = previous.snapshot?.pages.find(
          (current) => current.pageId === page.pageId,
        );
        return {
          ...previous,
          tabs: {
            ...previous.tabs,
            [page.pageId]: {
              ...origin,
              history: origin.history.map((old) =>
                old.id === entry.id
                  ? {
                      ...old,
                      result,
                      error: failure,
                      respondedAt,
                      historical:
                        old.historical ||
                        (result !== null && failure !== null) ||
                        previous.snapshot?.activationVersion !== snapshot?.activationVersion ||
                        previous.snapshot?.activePageId !== page.pageId ||
                        currentPage?.documentId !== page.documentId,
                    }
                  : old,
              ),
            },
          },
        };
      });
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
  function setInstruction(instruction: string) {
    if (page)
      setWorkspace((previous) => ({
        ...previous,
        tabs: { ...previous.tabs, [page.pageId]: { ...previous.tabs[page.pageId]!, instruction } },
      }));
  }
  function resetChat() {
    if (!page || pending.current) return;
    const latest = chat.history.at(-1);
    if (latest) spotlight(latest, null);
    setWorkspace((previous) => ({
      ...previous,
      tabs: {
        ...previous.tabs,
        [page.pageId]: { ...previous.tabs[page.pageId]!, instruction: "", history: [] },
      },
    }));
  }
  function setAddress(address: string) {
    setWorkspace((previous) =>
      page
        ? {
            ...previous,
            tabs: { ...previous.tabs, [page.pageId]: { ...previous.tabs[page.pageId]!, address } },
          }
        : { ...previous, initialAddress: address },
    );
  }
  return {
    session,
    page,
    pages: snapshot?.pages ?? [],
    address: page ? chat.address : workspace.initialAddress,
    addressFocus,
    instruction: chat.instruction,
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
    setAddress,
    dismissError: () => setError(""),
  };
}
