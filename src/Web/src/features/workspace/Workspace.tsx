import { ArrowRight, X } from "lucide-react";
import { lazy, Suspense } from "react";
import { Button } from "@/components/ui/button";
import ThemeToggle from "../theme/ThemeToggle";
import BrowserToolbar from "./BrowserToolbar";
import ChatPanel from "./ChatPanel";
import ResetSessionButton from "./ResetSessionButton";
import useWorkspace from "./useWorkspace";

const BrowserViewer = lazy(() => import("./BrowserViewer"));

export default function Workspace() {
  const {
    session,
    page,
    address,
    instruction,
    resolution,
    busy,
    error,
    pollError,
    start,
    navigate,
    resolve,
    setInstruction,
    setAddress,
    dismissError,
  } = useWorkspace();
  return (
    <div className="flex h-dvh min-h-80 flex-col">
      <header className="flex h-[54px] shrink-0 items-center justify-between border-b border-border px-4">
        <span className="text-xl font-semibold tracking-[-1px]">xpathed</span>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <ResetSessionButton disabled={!session || !!busy} onConfirm={start} />
        </div>
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
      {!!page?.blockedPopups && (
        <div
          className="flex min-h-9 shrink-0 items-center justify-between border-b border-border bg-muted px-4 py-1.5 text-sm text-muted-foreground"
          role="status"
        >
          New windows aren’t supported.
        </div>
      )}
      <main className="flex min-h-0 flex-1 flex-col sm:grid sm:grid-cols-[270px_minmax(0,1fr)] md:grid-cols-[320px_minmax(0,1fr)]">
        <ChatPanel
          key={session?.sessionId ?? "closed"}
          instruction={instruction}
          resolution={resolution}
          disabled={!page || !/^https?:\/\//i.test(page.url) || !!busy}
          resolving={busy === "Resolving…"}
          onInstructionChange={setInstruction}
          onResolve={resolve}
        />
        <section
          className="order-first flex min-h-0 min-w-0 flex-1 flex-col bg-background sm:order-none"
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
          <div className="relative min-h-0 flex-1 overflow-hidden bg-muted/50">
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
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <Button type="button" onClick={start} disabled={!!busy}>
                  {busy || "Open browser"}
                  <ArrowRight aria-hidden="true" />
                </Button>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
