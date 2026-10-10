import type {
  ImageMode,
  PageState,
  Resolution,
  ResolutionResult,
  Session,
  SessionState,
} from "./api";

export type Settings = { imageMode: ImageMode; autoExecute: boolean };
export type TabChat = Settings & {
  address: string;
  instruction: string;
  history: Resolution[];
};
export type WorkspaceState = {
  session: Session | null;
  snapshot: SessionState | null;
  tabs: Record<string, TabChat>;
  initialAddress: string;
  initialSettings: Settings;
};
export const defaultSettings: Settings = { imageMode: "auto", autoExecute: false };
export const emptyWorkspace: WorkspaceState = {
  session: null,
  snapshot: null,
  tabs: {},
  initialAddress: "",
  initialSettings: defaultSettings,
};
export const emptyChat: TabChat = { address: "", instruction: "", ...defaultSettings, history: [] };
export const pageAddress = (page: PageState) => (page.url === "about:blank" ? "" : page.url);
export const historical = (entries: Resolution[]) =>
  entries.map((entry) => (entry.historical ? entry : { ...entry, historical: true }));

export function updateSession(previous: WorkspaceState, snapshot: SessionState): WorkspaceState {
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

export function completeResolution(
  previous: WorkspaceState,
  page: PageState,
  activationVersion: number | undefined,
  entryId: string,
  result: ResolutionResult | null,
  failure: string | null,
  respondedAt: string,
): WorkspaceState {
  const origin = previous.tabs[page.pageId];
  if (!origin) return previous;
  const currentPage = previous.snapshot?.pages.find((current) => current.pageId === page.pageId);
  return {
    ...previous,
    tabs: {
      ...previous.tabs,
      [page.pageId]: {
        ...origin,
        history: origin.history.map((old) =>
          old.id === entryId
            ? {
                ...old,
                result,
                error: failure,
                respondedAt,
                historical:
                  old.historical ||
                  (result !== null && failure !== null) ||
                  previous.snapshot?.activationVersion !== activationVersion ||
                  previous.snapshot?.activePageId !== page.pageId ||
                  currentPage?.documentId !== page.documentId,
              }
            : old,
        ),
      },
    },
  };
}

export function recordExecution(
  previous: WorkspaceState,
  pageId: string,
  sessionId: string,
  entryId: string,
  execution: NonNullable<Resolution["execution"]>,
): WorkspaceState {
  const origin = previous.tabs[pageId];
  if (!origin || previous.session?.sessionId !== sessionId) return previous;
  return {
    ...previous,
    tabs: {
      ...previous.tabs,
      [pageId]: {
        ...origin,
        history: historical(origin.history).map((old) =>
          old.id === entryId ? { ...old, execution } : old,
        ),
      },
    },
  };
}

export function updateChat(
  previous: WorkspaceState,
  pageId: string,
  change: Partial<TabChat>,
): WorkspaceState {
  return {
    ...previous,
    tabs: { ...previous.tabs, [pageId]: { ...previous.tabs[pageId]!, ...change } },
  };
}
