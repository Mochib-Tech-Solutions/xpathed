export const profile = {
  id: "deepseek",
  model: process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4.1-flash",
  provider: process.env.OPENROUTER_PROVIDER || "wafer",
  reasoning: { enabled: false },
  maxTokens: 4096,
  resolver: "http://resolver:8080",
};
export const profiles = [profile];
