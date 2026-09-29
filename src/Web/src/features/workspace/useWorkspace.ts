import { useEffect, useRef, useState } from "react";
import { ApiError, request } from "./api";
import type { PageState, Session } from "./api";

type WorkspaceState = {
  session: Session | null;
  page: PageState | null;
  address: string;
};
const emptyWorkspace: WorkspaceState = { session: null, page: null, address: "" };

export default function useWorkspace() {
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const { session, page, address } = workspace;
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const pending = useRef(false);
  // Aborting an active request closes its session; ignore obsolete responses instead.
  const revision = useRef(0);

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
      void fetch(`/api/sessions/${session.sessionId}`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => undefined);
    };
    window.addEventListener("pagehide", close);
    return () => window.removeEventListener("pagehide", close);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const pageId = session.pageId;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const startedAt = revision.current;
      const isCurrent = () => active && !pending.current && revision.current === startedAt;
      try {
        if (pending.current) return;
        const next = await request<PageState>(`/pages/${pageId}`);
        if (!isCurrent()) return;
        setWorkspace((previous) => {
          if (previous.session?.pageId !== pageId) return previous;
          const pageChanged = previous.page?.url !== next.url;
          const updateAddress = pageChanged && (previous.page !== null || previous.address === "");
          const nextAddress = next.url === "about:blank" ? "" : next.url;
          return {
            ...previous,
            page: next,
            address: updateAddress ? nextAddress : previous.address,
          };
        });
        setPollError("");
      } catch (failure) {
        if (!isCurrent()) return;
        if (failure instanceof ApiError && failure.status === 404) {
          active = false;
          revision.current += 1;
          setWorkspace(emptyWorkspace);
          setError("Your browser session has ended. Open a new browser to continue.");
          setPollError("");
        } else {
          setPollError("Unable to refresh the page. Retrying…");
        }
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
  }, [session]);

  async function perform(label: string, action: (isCurrent: () => boolean) => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    const startedAt = ++revision.current;
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

  function start() {
    void perform("Opening browser", async (isCurrent) => {
      if (session) await request(`/sessions/${session.sessionId}`, "DELETE");
      if (!isCurrent()) return;
      setWorkspace(emptyWorkspace);
      const next = await request<Session>("/sessions", "POST");
      if (isCurrent()) setWorkspace({ ...emptyWorkspace, session: next });
    });
  }

  function navigate(url: string) {
    if (!session) return;
    void perform("Navigating", async (isCurrent) => {
      const next = await request<PageState>(`/pages/${session.pageId}/navigate`, "POST", { url });
      if (isCurrent())
        setWorkspace((previous) => ({
          ...previous,
          page: next,
          address: next.url === "about:blank" ? "" : next.url,
        }));
    });
  }

  function setAddress(address: string) {
    setWorkspace((previous) => ({ ...previous, address }));
  }

  function dismissError() {
    setError("");
  }

  return {
    session,
    page,
    address,
    busy,
    error,
    pollError,
    start,
    navigate,
    setAddress,
    dismissError,
  };
}
