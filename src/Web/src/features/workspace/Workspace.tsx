import { Globe2, X } from "lucide-react";
import { lazy, Suspense } from "react";
import { Button } from "@/components/ui/button";
import ThemeToggle from "../theme/ThemeToggle";
import BrowserToolbar from "./BrowserToolbar";
import BrowserTabs from "./BrowserTabs";
import ChatPanel from "./ChatPanel";
import useWorkspace from "./useWorkspace";

const BrowserViewer = lazy(() => import("./BrowserViewer"));

export default function Workspace() {
  const {
    session,
    page,
    pages,
    resolving,
    newTab,
    selectTab,
    closeTab,
    address,
    addressFocus,
    instruction,
    history,
    busy,
    error,
    pollError,
    closeAllTabs,
    navigate,
    resolve,
    setInstruction,
    resetChat,
    setAddress,
    dismissError,
  } = useWorkspace();
  return (
    <div className="flex h-dvh min-h-80 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-4">
          <span className="text-xl font-semibold tracking-[-1px]">xpathed</span>
          {session && (
            <span
              className="truncate font-mono text-xs text-muted-foreground"
              title={`Browser session: ${session.sessionId}`}
            >
              Session {session.sessionId}
            </span>
          )}
        </div>
        <ThemeToggle />
      </header>
      {error && (
        <div
          className="flex min-h-9 shrink-0 items-center justify-between border-b border-destructive/20 bg-destructive/10 px-4 py-1.5 text-sm text-destructive"
          role="alert"
        >
          <span>{error}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-destructive"
            onClick={dismissError}
            aria-label="Dismiss error"
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      )}
      {pollError && (
        <div
          className="flex min-h-9 shrink-0 items-center justify-between border-b border-border bg-muted px-4 py-1.5 text-sm text-muted-foreground"
          role="status"
        >
          {pollError}
        </div>
      )}
      {!!page?.blockedPopups && pages.length >= 8 && (
        <div
          className="flex min-h-9 shrink-0 items-center justify-between border-b border-border bg-muted px-4 py-1.5 text-sm text-muted-foreground"
          role="status"
        >
          The tab limit was reached. Close a tab to open another.
        </div>
      )}
      <main className="flex min-h-0 flex-1 flex-col sm:grid sm:grid-cols-[300px_minmax(0,1fr)] md:grid-cols-[360px_minmax(0,1fr)]">
        <ChatPanel
          key={page?.pageId ?? "closed"}
          instruction={instruction}
          history={history}
          ready={!!page && /^https?:\/\//i.test(page.url)}
          disabled={!page || !/^https?:\/\//i.test(page.url) || !!busy}
          resolving={resolving}
          onInstructionChange={setInstruction}
          onResolve={resolve}
          onReset={resetChat}
          resetDisabled={!page || !!busy}
        />
        <section
          className="order-first flex min-h-0 min-w-0 flex-1 flex-col bg-background sm:order-none"
          aria-label="Browser workspace"
        >
          {session && (
            <BrowserTabs
              pages={pages}
              activePageId={page?.pageId}
              busy={!!busy}
              onNew={newTab}
              onSelect={selectTab}
              onClose={closeTab}
              onCloseAll={closeAllTabs}
            />
          )}
          <BrowserToolbar
            sessionId={session?.sessionId}
            pageUrl={page?.url}
            address={address}
            focusRequest={addressFocus}
            busy={!!busy}
            onAddressChange={setAddress}
            onNavigate={navigate}
          />
          <div
            id="browser-panel"
            role={page ? "tabpanel" : undefined}
            aria-labelledby={page ? `tab-${page.pageId}` : undefined}
            className="relative min-h-0 flex-1 overflow-hidden bg-muted/50"
          >
            {session ? (
              <Suspense
                fallback={
                  <div
                    className="absolute inset-0 flex items-center justify-center text-muted-foreground"
                    role="status"
                  >
                    Connecting…
                  </div>
                }
              >
                <BrowserViewer key={session.sessionId} session={session} />
              </Suspense>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
                <Globe2 className="size-8 stroke-1" aria-hidden="true" />
                <p role="status">{busy || "Enter a website address above to begin."}</p>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
