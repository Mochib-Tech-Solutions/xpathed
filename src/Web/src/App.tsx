import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import RFB from "@novnc/novnc";

type Session = { sessionId: string; pageId: string; viewPath: string };
type PageState = {
  sessionId: string;
  pageId: string;
  url: string;
  title: string;
  blockedPopups: number;
};
type Inspection = {
  inspectedBy: string;
  page: PageState & {
    documentId: string | null;
    marker: string | null;
    scrollY: number;
    capturedAt: string;
  };
};
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function request<T>(path: string, method = "GET", body?: object): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error: unknown = await response.json().catch(() => null);
    const message =
      error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message
        : "The workspace is unavailable. Please try again.";
    throw new ApiError(message, response.status);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}
function Icon({
  name,
  size = 18,
}: {
  name: "arrow" | "refresh" | "home" | "close" | "scan";
  size?: number;
}) {
  const paths = {
    arrow: "M4 12h16m-6-6 6 6-6 6",
    refresh: "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1",
    home: "m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8",
    close: "m6 6 12 12M6 18 18 6",
    scan: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 12h8m-4-4v8",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
function Viewer({ session, onStatus }: { session: Session; onStatus: (status: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = host.current!;
    const url = new URL(session.viewPath, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const rfb = new RFB(container, url.toString());
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.background = "#fff";
    rfb.focusOnClick = true;
    const connected = () => onStatus("Connected");
    rfb.addEventListener("connect", connected);
    const disconnected = () => onStatus("Disconnected");
    rfb.addEventListener("disconnect", disconnected);
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "F8" || (event.key === "Enter" && event.target === container)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "F8") container.focus();
        else rfb.focus();
      }
    };
    container.addEventListener("keydown", keyboard, true);
    return () => {
      container.removeEventListener("keydown", keyboard, true);
      rfb.removeEventListener("connect", connected);
      rfb.removeEventListener("disconnect", disconnected);
      rfb.disconnect();
    };
  }, [session, onStatus]);
  return (
    <div
      className="viewer"
      ref={host}
      role="group"
      tabIndex={0}
      aria-label="Managed browser. Press Enter to interact, F8 to leave the browser, then Tab to move to the next control."
    />
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [page, setPage] = useState<PageState | null>(null);
  const [address, setAddress] = useState("");
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [viewStatus, setViewStatus] = useState("Disconnected");
  const [viewerKey, setViewerKey] = useState(0);
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
    let previousUrl: string | null = null;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await request<PageState>(`/pages/${pageId}`);
        if (!active) return;
        if (previousUrl !== next.url) {
          setAddress(next.url);
          setInspection(null);
        }
        previousUrl = next.url;
        setPage(next);
        setPollError("");
      } catch (failure) {
        if (!active) return;
        if (failure instanceof ApiError && failure.status === 404) {
          active = false;
          setError("Your browser session has ended. Open a new browser to continue.");
          setSession(null);
          setPage(null);
          setInspection(null);
          setAddress("");
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

  async function perform(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Something went wrong. Please try again.",
      );
    } finally {
      setBusy("");
    }
  }
  function start() {
    void perform("Opening browser", async () => {
      if (session) await request(`/sessions/${session.sessionId}`, "DELETE");
      setSession(null);
      setPage(null);
      setInspection(null);
      setAddress("");
      setPollError("");
      setViewStatus("Connecting");
      setSession(await request<Session>("/sessions", "POST"));
      setError("");
    });
  }
  function close() {
    if (!session) return;
    void perform("Closing browser", async () => {
      await request(`/sessions/${session.sessionId}`, "DELETE");
      setSession(null);
      setPage(null);
      setInspection(null);
      setAddress("");
      setPollError("");
      setError("");
    });
  }
  function navigate(url: string) {
    if (!session) return;
    void perform("Navigating", async () => {
      setInspection(null);
      const next = await request<PageState>(`/pages/${session.pageId}/navigate`, "POST", { url });
      setPage(next);
      setAddress(next.url);
    });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const url = address.trim();
    navigate(/^[a-z][a-z\d+.-]*:/i.test(url) ? url : `https://${url}`);
  }
  const connected = viewStatus === "Connected" && !!session;
  return (
    <div className="app">
      <header className="topbar">
        <a href="/" className="brand" aria-label="xpathed home">
          xpathed<span>.</span>
        </a>
        <div className="session-actions">
          <button className="button" onClick={start} disabled={!session || !!busy}>
            <Icon name="refresh" size={15} />
            Reset session
          </button>
          {session && (
            <button
              className="icon-button"
              onClick={close}
              disabled={!!busy}
              aria-label="Close browser session"
              title="Close browser session"
            >
              <Icon name="close" />
            </button>
          )}
        </div>
      </header>
      {error && (
        <div className="notice error" role="alert">
          <span>{error}</span>
          <button className="icon-button" onClick={() => setError("")} aria-label="Dismiss error">
            <Icon name="close" />
          </button>
        </div>
      )}
      {pollError && (
        <div className="notice" role="status">
          {pollError}
        </div>
      )}
      {!!page?.blockedPopups && (
        <div className="notice" role="status">
          New windows aren’t supported.
        </div>
      )}
      <main className="workspace">
        <aside className="chat" aria-label="Chat">
          <div className="chat-toolbar">
            <h1>Chat</h1>
            <button
              className="button"
              disabled={!connected || !!busy}
              onClick={() =>
                session &&
                void perform("Inspecting page", async () =>
                  setInspection(
                    await request<Inspection>(`/pages/${session.pageId}/inspect`, "POST"),
                  ),
                )
              }
            >
              <Icon name="scan" size={15} />
              {busy === "Inspecting page" ? "Inspecting…" : "Inspect page"}
            </button>
          </div>
          <div className="messages" aria-live="polite">
            {inspection && (
              <>
                <div className="user-message">Inspect page</div>
                <div className="inspection-result">
                  <p className="message-label">
                    {inspection.page.marker === null ? "Page title" : "Current marker"}
                  </p>
                  <p className="marker-value">{inspection.page.marker ?? inspection.page.title}</p>
                  <details>
                    <summary>Page details</summary>
                    <dl>
                      <div>
                        <dt>Scroll</dt>
                        <dd>{Math.round(inspection.page.scrollY)} px</dd>
                      </div>
                      <div>
                        <dt>Captured</dt>
                        <dd>{new Date(inspection.page.capturedAt).toLocaleTimeString()}</dd>
                      </div>
                    </dl>
                    <span className="message-label">Page identity</span>
                    <code>{inspection.page.pageId}</code>
                    {inspection.page.documentId && (
                      <>
                        <span className="message-label">Document</span>
                        <code>{inspection.page.documentId}</code>
                      </>
                    )}
                  </details>
                </div>
              </>
            )}
          </div>
          <div className="composer" title="Command resolution is not available yet.">
            <textarea
              aria-label="Describe an element"
              placeholder="Describe an element…"
              rows={2}
              disabled
            />
            <button className="send-button" aria-label="Send command" disabled>
              <Icon name="arrow" size={17} />
            </button>
          </div>
        </aside>
        <section className="browser-shell" aria-label="Browser workspace">
          <form className="address-bar" onSubmit={submit}>
            <button
              type="button"
              className="icon-button"
              title="Welcome page"
              aria-label="Welcome page"
              onClick={() => navigate("xpathed:welcome")}
              disabled={!session || !!busy}
            >
              <Icon name="home" size={17} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="Reload page"
              aria-label="Reload page"
              onClick={() => page && navigate(page.url)}
              disabled={!page || !!busy}
            >
              <Icon name="refresh" size={17} />
            </button>
            <input
              aria-label="Page address"
              placeholder="Enter a website address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              disabled={!session || !!busy}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              className="icon-button"
              aria-label="Go to address"
              disabled={!session || !address.trim() || !!busy}
            >
              <Icon name="arrow" size={17} />
            </button>
          </form>
          <div className="browser-content">
            {session ? (
              <Viewer key={viewerKey} session={session} onStatus={setViewStatus} />
            ) : (
              <div className="empty-browser">
                <button className="button primary" onClick={start} disabled={!!busy}>
                  {busy || "Open browser"}
                  <Icon name="arrow" size={17} />
                </button>
              </div>
            )}
            {session && viewStatus !== "Connected" && (
              <div className="viewer-overlay">
                <p>{viewStatus === "Connecting" ? "Connecting…" : "Browser disconnected."}</p>
                {viewStatus === "Disconnected" && (
                  <button
                    className="button"
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
