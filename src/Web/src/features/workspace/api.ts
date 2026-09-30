export type Session = { sessionId: string; pageId: string; viewPath: string };

export type PageState = {
  sessionId: string;
  pageId: string;
  documentId: string;
  url: string;
  title: string;
  blockedPopups: number;
};

export type ResolutionResult = {
  contractVersion: "1";
  outcome: "found" | "not_found" | "unsupported" | "error";
  sessionId: string | null;
  pageId: string;
  documentId: string;
  captureId: string | null;
  frameId: string | null;
  traceId: string;
  attemptId: string;
  configurationId: string;
  action: string | null;
  target: {
    candidateId: string;
    tag: string;
    label: string;
    xpaths: string[];
    state: {
      rendered: boolean;
      inViewport: boolean;
      enabled: boolean;
      editable: boolean;
      checked: boolean | null;
    };
    geometry: { x: number; y: number; width: number; height: number };
  } | null;
  diagnostics: {
    code: string | null;
    message: string | null;
    timingsMs?: { total?: number };
  };
};

export type Resolution = { instruction: string; result: ResolutionResult };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(path: string, method = "GET", body?: object): Promise<T> {
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
