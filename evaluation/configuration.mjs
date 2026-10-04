const model = process.env.OPENROUTER_MODEL || "google/gemini-3.8-flash";
export const profile = {
  id: model === "google/gemini-3.8-flash" ? "gemini" : "configured",
  model,
  provider: process.env.OPENROUTER_PROVIDER || "google-ai-studio",
  reasoning:
    model === "google/gemini-3.8-flash"
      ? { enabled: true, effort: "low", exclude: true }
      : { enabled: false },
  maxTokens: 4096,
  resolver: "http://resolver:8080",
};
export const profiles = [profile];
