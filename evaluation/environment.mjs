import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

export async function readEvaluationKey(env = process.env) {
  if (env.OPENROUTER_EVAL_API_KEY?.trim()) return env.OPENROUTER_EVAL_API_KEY.trim();
  try {
    return (
      parseEnv(
        await readFile(env.XPATHED_ENV_FILE ?? ".env", "utf8"),
      ).OPENROUTER_EVAL_API_KEY?.trim() || undefined
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  }
}
