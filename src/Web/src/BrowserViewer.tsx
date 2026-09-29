import { useEffect, useRef } from "react";
import RFB from "@novnc/novnc";
import type { Session } from "./api";

export type ViewerStatus = "Connecting" | "Connected" | "Disconnected";

export default function BrowserViewer({
  session,
  onStatus,
}: {
  session: Session;
  onStatus: (status: ViewerStatus) => void;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let active = true;
    const url = new URL(session.viewPath, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const rfb = new RFB(container, url.toString());
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.background = "#fff";
    rfb.focusOnClick = true;
    const connected = () => {
      if (active) onStatus("Connected");
    };
    const disconnected = () => {
      if (active) onStatus("Disconnected");
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
  }, [session, onStatus]);

  return (
    <div
      className="viewer absolute inset-0 h-full w-full focus-visible:-outline-offset-4"
      ref={host}
      role="application"
      tabIndex={0}
      aria-label="Managed browser. Press Enter to interact, F8 to leave the browser, then Tab to move to the next control."
    />
  );
}
