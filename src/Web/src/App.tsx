import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, request } from "./api";
import type { PageState, Session } from "./api";
import BrowserViewer from "./BrowserViewer";
import type { ViewerStatus } from "./BrowserViewer";
import ChatPanel from "./ChatPanel";
import Icon from "./Icon";

type Workspace = {
  session: Session | null;
  page: PageState | null;
  address: string;
};
const emptyWorkspace: Workspace = { session: null, page: null, address: "" };

export default function App() {
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const { session, page, address } = workspace;
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [viewStatus, setViewStatus] = useState<ViewerStatus>("Disconnected");
  const [viewerKey, setViewerKey] = useState(0);
  const resetDialog = useRef<HTMLDialogElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
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
    addressInput.current?.focus();
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
          setViewStatus("Disconnected");
          setError("Your browser session has ended. Open a new browser to continue.");
          setPollError("");
        } else {
          setPollError("Unable to refresh the page. Retrying…");
        }
      } finally {
        if (active) timer = setTimeout(refresh, 2000);
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
      setViewStatus("Connecting");
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

  function submit(event: FormEvent) {
    event.preventDefault();
    const url = address.trim();
    if (url) navigate(/^[a-z][a-z\d+.-]*:/i.test(url) ? url : `https://${url}`);
  }

  const hasPage = /^https?:\/\//i.test(page?.url ?? "");
  return (
    <div className="flex h-dvh min-h-80 flex-col">
      <header className="flex h-[54px] shrink-0 items-center justify-between border-b border-line px-[18px]">
        <span className="text-xl font-[650] tracking-[-1px]">
          xpathed<span className="text-accent">.</span>
        </span>
        <button
          type="button"
          className="inline-flex items-center justify-center gap-2 rounded-md border border-[#dfdbe4] bg-white px-[11px] py-2 text-sm whitespace-nowrap enabled:hover:bg-soft"
          onClick={() => resetDialog.current?.showModal()}
          disabled={!session || !!busy}
        >
          <Icon name="refresh" size={15} />
          Reset session
        </button>
      </header>
      <dialog
        ref={resetDialog}
        aria-labelledby="reset-title"
        aria-describedby="reset-description"
        className="m-auto w-[400px] max-w-[calc(100vw-32px)] rounded-xl border border-line bg-white p-6 text-ink shadow-lg backdrop:bg-ink/30"
      >
        <h2 id="reset-title" className="font-semibold">
          Reset session?
        </h2>
        <p id="reset-description" className="mt-3 leading-relaxed text-muted">
          Your page, chat and browsing state will be cleared.
        </p>
        <form method="dialog" className="mt-6 flex justify-end gap-2">
          <button
            type="submit"
            autoFocus
            className="rounded-md border border-[#dfdbe4] bg-white px-3 py-2 text-sm enabled:hover:bg-soft"
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md border border-accent bg-accent px-3 py-2 text-sm text-white enabled:hover:bg-accent-hover"
            disabled={!session || !!busy}
            onClick={() => {
              resetDialog.current?.close();
              start();
            }}
          >
            Reset session
          </button>
        </form>
      </dialog>
      {error && (
        <div
          className="flex min-h-9 shrink-0 items-center justify-between bg-[#fff0ed] px-[18px] py-1.5 text-sm text-[#944a3d]"
          role="alert"
        >
          <span>{error}</span>
          <button
            type="button"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-[5px] border-0 bg-transparent text-muted enabled:hover:bg-soft"
            onClick={() => setError("")}
            aria-label="Dismiss error"
          >
            <Icon name="close" />
          </button>
        </div>
      )}
      {pollError && (
        <div
          className="flex min-h-9 shrink-0 items-center justify-between bg-soft px-[18px] py-1.5 text-sm text-[#65547c]"
          role="status"
        >
          {pollError}
        </div>
      )}
      {!!page?.blockedPopups && (
        <div
          className="flex min-h-9 shrink-0 items-center justify-between bg-soft px-[18px] py-1.5 text-sm text-[#65547c]"
          role="status"
        >
          New windows aren’t supported.
        </div>
      )}
      <main className="flex min-h-0 flex-1 flex-col sm:grid sm:grid-cols-[270px_minmax(0,1fr)] md:grid-cols-[320px_minmax(0,1fr)]">
        <ChatPanel />
        <section
          className="order-first flex min-h-0 min-w-0 flex-1 flex-col bg-white sm:order-none"
          aria-label="Browser workspace"
        >
          <form
            className="flex min-h-[53px] items-center gap-[5px] border-b border-[#e8e5eb] px-3 py-2"
            onSubmit={submit}
          >
            <button
              type="button"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-[5px] border-0 bg-transparent text-muted enabled:hover:bg-soft"
              title="Reload page"
              aria-label="Reload page"
              onClick={() => page && navigate(page.url)}
              disabled={!hasPage || !!busy}
            >
              <Icon name="refresh" size={17} />
            </button>
            <input
              ref={addressInput}
              className="h-[33px] min-w-0 flex-1 rounded-[5px] border border-[#e7e4eb] bg-[#f8f7fa] px-2.5 text-sm placeholder:text-muted placeholder:opacity-100"
              aria-label="Page address"
              placeholder="Enter a website address"
              value={address}
              onChange={(event) => {
                const address = event.currentTarget.value;
                setWorkspace((previous) => ({ ...previous, address }));
              }}
              disabled={!session || !!busy}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="submit"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-[5px] border-0 bg-transparent text-muted enabled:hover:bg-soft"
              aria-label="Go to address"
              disabled={!session || !address.trim() || !!busy}
            >
              <Icon name="arrow" size={17} />
            </button>
          </form>
          <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
            {session ? (
              <BrowserViewer key={viewerKey} session={session} onStatus={setViewStatus} />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#faf9f7]">
                <button
                  type="button"
                  className="inline-flex items-center justify-center gap-2 rounded-md border border-accent bg-accent px-4 py-2.5 text-sm whitespace-nowrap text-white enabled:hover:bg-accent-hover"
                  onClick={start}
                  disabled={!!busy}
                >
                  {busy || "Open browser"}
                  <Icon name="arrow" size={17} />
                </button>
              </div>
            )}
            {session && viewStatus !== "Connected" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-paper/93 text-muted">
                <p className="my-[13px]">
                  {viewStatus === "Connecting" ? "Connecting…" : "Browser disconnected."}
                </p>
                {viewStatus === "Disconnected" && (
                  <button
                    type="button"
                    className="inline-flex items-center justify-center gap-2 rounded-md border border-[#dfdbe4] bg-white px-[11px] py-2 text-sm whitespace-nowrap enabled:hover:bg-soft"
                    onClick={() => {
                      setViewStatus("Connecting");
                      setViewerKey((key) => key + 1);
                    }}
                  >
                    Reconnect view
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
