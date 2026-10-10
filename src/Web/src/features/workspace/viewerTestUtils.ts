import { act } from "@testing-library/react";
import { beforeEach, vi } from "vitest";

export class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  send = vi.fn();
  close = vi.fn();
  constructor(readonly url: URL) {
    Socket.instances.push(this);
  }
}

export class Picture {
  static instances: Picture[] = [];
  onload?: () => void;
  onerror?: () => void;
  src = "";
  constructor() {
    Picture.instances.push(this);
  }
}

export const session = {
  sessionId: "s1",
  pageId: "p1",
  viewPath: "/view/s1",
  browserType: "chromium" as const,
  resolution: "1280x800",
};

export const frame = {
  type: "frame",
  frameId: 1,
  pageId: "p1",
  documentId: "d1",
  width: 1280,
  height: 800,
  data: "image",
};

export const picker = {
  type: "select",
  pageId: "p1",
  documentId: "d1",
  pickerId: "picker-1",
  options: [
    { id: "option-a", label: "First option", disabled: false, selected: true },
    { id: "option-b", label: "Second option", disabled: false, selected: false },
    { id: "option-c", label: "Unavailable", disabled: true, selected: false },
  ],
};

export const socket = () => Socket.instances.at(-1)!;

export const sent = () =>
  socket().send.mock.calls.map(
    ([message]) => JSON.parse(message as string) as Record<string, unknown>,
  );

export function draw(value = frame) {
  act(() => socket().onmessage?.({ data: JSON.stringify(value) }));
  act(() => Picture.instances.at(-1)?.onload?.());
}

beforeEach(() => {
  Socket.instances = [];
  Picture.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("Image", Picture);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
});
