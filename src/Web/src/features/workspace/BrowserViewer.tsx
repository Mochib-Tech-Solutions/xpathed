import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import { Button } from "@/components/ui/button";
import type { Session } from "./api";

type ViewerStatus = "Connecting" | "Connected" | "Disconnected";

export default function BrowserViewer({ session }: { session: Session }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ViewerStatus>("Connecting");
  const [connection, setConnection] = useState(0);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let active = true;
    const url = new URL(session.viewPath, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const rfb = new RFB(container, url.toString());
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.background = "transparent";
    rfb.focusOnClick = true;
    const connected = () => {
      if (active) setStatus("Connected");
    };
    const disconnected = () => {
      if (active) setStatus("Disconnected");
    };
    rfb.addEventListener("connect", connected);
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
      active = false;
      container.removeEventListener("keydown", keyboard, true);
      rfb.removeEventListener("connect", connected);
      rfb.removeEventListener("disconnect", disconnected);
      rfb.disconnect();
    };
  }, [session.viewPath, connection]);

  return (
    <>
      <div
        className="viewer absolute inset-0 h-full w-full focus-visible:-outline-offset-4"
        ref={host}
        role="application"
        tabIndex={0}
        aria-label="Managed browser. Press Enter to interact, F8 to leave the browser, then Tab to move to the next control."
      />
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
    </>
  );
}
