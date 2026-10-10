import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Session } from "./api";
import type { ViewerStatus, DialogState, SelectState } from "./viewerProtocol";
import connectViewer from "./connectViewer";
import BrowserSelectPicker from "./BrowserSelectPicker";
import BrowserDialog from "./BrowserDialog";

export default function BrowserViewer({ session }: { session: Session }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const keyboardInput = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState<ViewerStatus>("Connecting");
  const [connection, setConnection] = useState(0);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [picker, setPicker] = useState<SelectState | null>(null);

  useEffect(() => {
    const container = host.current;
    const surface = canvas.current;
    const input = keyboardInput.current;
    if (!container || !surface || !input) return;
    return connectViewer(
      session.viewPath,
      container,
      surface,
      input,
      setStatus,
      setDialog,
      setPicker,
    );
  }, [session.viewPath, connection]);

  useEffect(() => {
    if (status !== "Disconnected") return;
    const retry = window.setTimeout(() => {
      setStatus("Connecting");
      setConnection((previous) => previous + 1);
    }, 1000);
    return () => window.clearTimeout(retry);
  }, [status, session.viewPath]);

  return (
    <>
      <div
        className="absolute inset-0 flex h-full w-full items-center justify-center overflow-hidden focus-visible:-outline-offset-4"
        ref={host}
        role="application"
        tabIndex={0}
        aria-label="Managed browser. Press Enter to interact, F8 to leave the browser, then Tab to move to the next control."
      >
        <canvas
          ref={canvas}
          className="h-auto max-h-full w-auto max-w-full touch-none"
          aria-hidden="true"
        />
        <textarea
          ref={keyboardInput}
          tabIndex={-1}
          aria-label="Managed browser keyboard input"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="absolute top-0 left-0 h-px w-px resize-none opacity-0"
        />
      </div>
      {status !== "Connected" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/95 text-muted-foreground">
          <p className="my-[13px]">
            {status === "Connecting" ? "Connecting…" : "Browser disconnected."}
          </p>
          {status === "Disconnected" && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setStatus("Connecting");
                setConnection((previous) => previous + 1);
              }}
            >
              Reconnect view
            </Button>
          )}
        </div>
      )}
      <BrowserSelectPicker picker={picker} onClose={() => host.current?.focus()} />
      <BrowserDialog dialog={dialog} onClose={() => host.current?.focus()} />
    </>
  );
}
