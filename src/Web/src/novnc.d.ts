declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string);
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    focusOnClick: boolean;
    focus(): void;
    disconnect(): void;
  }
}
