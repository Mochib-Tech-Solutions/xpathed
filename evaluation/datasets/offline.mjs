import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function normalize(result, attemptId) {
  if (result.outcome === "error")
    return {
      contractVersion: "offline-1",
      outcome: "error",
      action: null,
      actions: [],
      summary: null,
      diagnostics: result.diagnostics,
      configurationId: result.configurationId,
      attemptId,
    };
  if (!Array.isArray(result.actions) || !result.actions.length)
    throw new Error("Offline selection has no target items");
  const outcomes = new Set(result.actions.map((item) => item.outcome));
  return {
    contractVersion: "offline-1",
    outcome: outcomes.size === 1 ? result.actions[0].outcome : "partial",
    action: result.action,
    attemptId,
    configurationId: result.configurationId,
    actions: result.actions.map((item, index) => ({
      actionId: `a${index + 1}`,
      order: index + 1,
      step: item.step,
      action: item.action,
      outcome: item.outcome,
      diagnosticsReference: attemptId,
      target: item.candidateId == null ? null : { candidateId: item.candidateId },
    })),
    diagnostics: result.diagnostics ?? {},
  };
}

// The host executes this request using the attested Resolver container, including old releases.
export async function executeOffline(spec, trial, output, timeoutMs, baseline) {
  const directory = join(output, "offline");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, trial.id);
  const started = performance.now();
  try {
    await writeFile(`${path}.partial`, JSON.stringify({ baseline, input: spec.input }), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(`${path}.partial`, `${path}.request.json`);
    let response;
    while (!response) {
      try {
        response = JSON.parse(await readFile(`${path}.response.json`, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (performance.now() - started > timeoutMs + 65000)
        throw new Error("Offline Resolver did not return evidence");
      if (!response) await delay(100);
    }
    if (response.error) throw new Error(response.error);
    const { prepared, result, elapsedMs } = response;
    trial.evidence = {
      availability: "available",
      modelInput: prepared.modelInput,
      systemPrompt: prepared.prompt,
      outputSchema: JSON.stringify(prepared.schema),
      configurationJson: JSON.stringify({
        Model: prepared.effective.request.model,
        Provider: prepared.effective.request.provider.only[0],
        Strategy: prepared.effective.strategy,
        PromptVersion: prepared.promptVersion,
        effective: prepared.effective,
      }),
    };
    trial.result = normalize(result, trial.id);
    trial.elapsedMs = elapsedMs;
    trial.observation = {
      modelInputCoverage: {
        expected: 1,
        found: Number(
          spec.input.candidates.some(
            (candidate) => candidate.id === spec.expected.actions[0].target.candidateId,
          ),
        ),
      },
    };
  } catch (error) {
    trial.error = { code: "offline_execution_failed", message: error.message };
    trial.elapsedMs = performance.now() - started;
  }
}
