export const stagehandVersion = "4.1.0";

// Stagehand's generated paths cross document boundaries; standard XPath cannot.
export function normalizeSelector(selector) {
  if (typeof selector !== "string" || !selector.startsWith("xpath="))
    throw new Error("unsupported_selector");
  const path = selector.slice(6);
  if (!/^\/(?:[a-z][a-z0-9-]*\[[1-9]\d*\]\/)*[a-z][a-z0-9-]*\[[1-9]\d*\]$/.test(path))
    throw new Error("unsupported_xpath");
  const parts = path.split(/(?<=\/(?:iframe|frame)\[\d+\])(?=\/html\[1\])/);
  if (parts.some((part) => !part.startsWith("/html[1]/")))
    throw new Error("unsupported_frame_path");
  return {
    xpaths: [parts.at(-1)],
    frame: { chain: parts.slice(0, -1).map((xpath) => ({ xpath })) },
  };
}

export function normalizeActions(actions, cardinality) {
  if (!["singleton", "all"].includes(cardinality)) throw new Error("invalid_cardinality");
  const selected = cardinality === "singleton" ? actions.slice(0, 1) : actions;
  const targets = [];
  const unsupported = [];
  for (const [index, action] of selected.entries()) {
    try {
      const target = normalizeSelector(action.selector);
      targets.push({ ...target, method: action.method, description: action.description });
    } catch (error) {
      unsupported.push({ index, reason: error.message });
    }
  }
  return {
    status: !selected.length ? "empty" : unsupported.length ? "unsupported" : "found",
    targets,
    unsupported,
    selectedCount: selected.length,
  };
}

export function deterministicObservation(params, plan = {}) {
  if (plan.fault === "error") throw new Error("controlled_provider_error");
  const text = params.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : [message.content]))
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const lines = text.split("\n").filter((line) => /\[\d+-\d+\]/.test(line));
  const elements = (plan.elements ?? []).flatMap((entry) => {
    const matches = lines.filter(
      (line) => line.includes(entry.label) && (!entry.role || line.includes(`] ${entry.role}`)),
    );
    const chosen = entry.all ? matches : [matches[entry.index ?? 0]].filter(Boolean);
    return chosen.map((line) => ({
      elementId: /\[(\d+-\d+)\]/.exec(line)[1],
      description: entry.label,
      method: entry.method ?? "click",
      arguments: [],
    }));
  });
  return {
    role: "assistant",
    content: { type: "text", text: JSON.stringify({ elements }) },
    outputFormat: "json_schema",
    structuredContent: { elements },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

export async function requestObservation(params, url, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer comparison-only" },
    signal: AbortSignal.timeout(45000),
    body: JSON.stringify({
      model: "deepseek/deepseek-v4.1-flash",
      provider: { only: ["wafer"], allow_fallbacks: false },
      max_tokens: 4096,
      reasoning: { enabled: false },
      messages: [
        { role: "system", content: params.systemPrompt },
        ...params.messages.map((message) => ({
          role: message.role,
          content: (Array.isArray(message.content) ? message.content : [message.content])
            .map((block) => {
              if (block.type !== "text") throw new Error("unsupported_model_content");
              return block.text;
            })
            .join("\n"),
        })),
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: params.responseFormat.name,
          strict: true,
          schema: params.responseFormat.schema,
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`model_http_${response.status}`);
  const body = await response.json();
  if (body.choices?.[0]?.finish_reason !== "stop") throw new Error("model_incomplete");
  const content = body.choices[0].message.content;
  const usage = body.usage;
  return {
    role: "assistant",
    content: { type: "text", text: content },
    outputFormat: "json_schema",
    structuredContent: JSON.parse(content),
    ...(usage
      ? {
          usage: {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          },
        }
      : {}),
  };
}
