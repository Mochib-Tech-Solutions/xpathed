export type Session = { sessionId: string; pageId: string; viewPath: string };

export type PageState = {
  sessionId: string;
  pageId: string;
  documentId: string;
  url: string;
  title: string;
  blockedPopups: number;
};

export type SessionState = {
  sessionId: string;
  activePageId: string;
  activationVersion: number;
  viewPath: string;
  pages: PageState[];
};

export type ResolutionResult = {
  contractVersion: "1" | "2";
  outcome: "found" | "not_found" | "unsupported" | "error" | "partial";
  sessionId: string | null;
  pageId: string;
  documentId: string;
  captureId: string | null;
  frameId: string | null;
  traceId: string;
  attemptId: string;
  configurationId: string;
  action: string | null;
  actions?: ActionResolution[] | null;
  inspectedActionId?: string | null;
  summary?: {
    processingComplete: boolean;
    semanticCompleteness: "unverified";
    total: number;
    found: number;
    notFound: number;
    unsupported: number;
    errors: number;
    blocked: number;
    readinessUnknown: number;
    assessmentUnsupported: number;
  } | null;
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
      version?: "1" | "2";
      accessibilityExposed?: boolean | null;
      readonly?: boolean | null;
    };
    interactability?: {
      version: "1";
      action: string;
      status: "blocked" | "unknown" | "unsupported";
      reasons: string[];
      checks: Record<string, "pass" | "fail" | "unknown" | "not_applicable">;
    } | null;
    geometry: { x: number; y: number; width: number; height: number };
  } | null;
  diagnostics: {
    code: string | null;
    message: string | null;
    timingsMs?: { total?: number };
    model?: string | null;
    provider?: string | null;
    usage?: {
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
      reasoningTokens: number | null;
      cachedTokens: number | null;
      cost: number | null;
    } | null;
    costEstimate?: {
      currency: "USD";
      inputPricePerMillion: number;
      outputPricePerMillion: number;
      inputCost: number;
      outputCost: number;
      requestCost: number;
      totalCost: number;
      pricingFetchedAt: string;
    } | null;
  };
};

export type ActionResolution = {
  actionId: string;
  order: number;
  step: number;
  instruction: string;
  action: string;
  outcome: "found" | "not_found" | "unsupported" | "error";
  target: ResolutionResult["target"];
  frameId: string;
  diagnosticsReference: string;
  code: string | null;
  message: string | null;
};

export type Resolution = {
  id: string;
  instruction: string;
  createdAt: string;
  pageUrl: string;
  pageTitle: string;
  documentId: string;
  historical: boolean;
  result: ResolutionResult | null;
  error: string | null;
};

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
