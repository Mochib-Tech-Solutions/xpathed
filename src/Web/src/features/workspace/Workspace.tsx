import Icon from "../../components/Icon";
import BrowserToolbar from "./BrowserToolbar";
import BrowserViewer from "./BrowserViewer";
import ChatPanel from "./ChatPanel";
import ResetSessionButton from "./ResetSessionButton";
import useWorkspace from "./useWorkspace";

export default function Workspace() {
  const {
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
  } = useWorkspace();
  return (
    <div className="flex h-dvh min-h-80 flex-col">
      <header className="flex h-[54px] shrink-0 items-center justify-between border-b border-line px-[18px]">
        <span className="text-xl font-[650] tracking-[-1px]">
          xpathed<span className="text-accent">.</span>
        </span>
        <ResetSessionButton disabled={!session || !!busy} onConfirm={start} />
      </header>
      {error && (
        <div
          className="flex min-h-9 shrink-0 items-center justify-between bg-[#fff0ed] px-[18px] py-1.5 text-sm text-[#944a3d]"
          role="alert"
        >
          <span>{error}</span>
          <button
            type="button"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-[5px] border-0 bg-transparent text-muted enabled:hover:bg-soft"
            onClick={dismissError}
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
          <BrowserToolbar
            sessionId={session?.sessionId}
            pageUrl={page?.url}
            address={address}
            busy={!!busy}
            onAddressChange={setAddress}
            onNavigate={navigate}
          />
          <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
            {session ? (
              <BrowserViewer key={session.sessionId} session={session} />
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
          </div>
        </section>
      </main>
    </div>
  );
}
