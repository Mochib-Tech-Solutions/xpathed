export type ViewerStatus = "Connecting" | "Connected" | "Disconnected";
export type Frame = {
  type: "frame";
  frameId: number;
  pageId: string;
  documentId: string;
  width: number;
  height: number;
  data: string;
};
export type PageDialog = {
  type: "dialog";
  pageId: string;
  documentId: string;
  dialogId: string;
  dialogType: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt: string;
};
export type PageSelect = {
  type: "select";
  pageId: string;
  documentId: string;
  pickerId: string;
  options: { id: string; label: string; disabled: boolean; selected: boolean }[];
};
export type SelectState = PageSelect & {
  pending: boolean;
  answer: (optionId: string | null) => void;
};
export type DialogState = PageDialog & {
  pending: boolean;
  answer: (accept: boolean, promptText?: string) => void;
};
