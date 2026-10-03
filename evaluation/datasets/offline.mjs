import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function normalize(result, attemptId) {
  if (result.outcome === "error")
    return {
      outcome: "error",
      action: null,
      actions: [],
      summary: null,
      diagnostics: result.diagnostics,
      configurationId: result.configurationId,
      attemptId,
    };
  if (!Array.isArray(result.actions) || !result.actions.length)
    throw new Error("Saved-page selection has no target items");
  const outcomes = new Set(result.actions.map((item) => item.outcome));
  return {
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
export async function executeOffline(spec, trial, output, timeoutMs, baseline, workerId) {
  if (workerId !== undefined && (!Number.isInteger(workerId) || workerId < 0 || workerId > 15))
    throw new Error("Invalid Saved-page selection worker identity");
  const directory = join(output, "offline");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, trial.id);
  const started = performance.now();
  try {
    const expectedPreparedInputHash = spec.labelReview?.preparedInputHash;
    if (
      typeof expectedPreparedInputHash !== "string" ||
      !/^[a-f\d]{64}$/.test(expectedPreparedInputHash)
    )
      throw Object.assign(
        new Error("Saved-page selection input requires a reviewed prepared input hash"),
        {
          code: "unreviewed_prepared_input",
        },
      );
    await writeFile(
      `${path}.partial`,
      JSON.stringify({
        baseline,
        input: spec.input,
        expectedPreparedInputHash,
        ...(workerId === undefined ? {} : { workerId }),
      }),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    await rename(`${path}.partial`, `${path}.request.json`);
    let response;
    while (!response) {
      try {
        response = JSON.parse(await readFile(`${path}.response.json`, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (performance.now() - started > timeoutMs + 65000)
        throw new Error("Saved-page selection worker did not return evidence");
      if (!response) await delay(100);
    }
    const { prepared, result, elapsedMs } = response;
    if (prepared)
      trial.evidence = {
        availability: "available",
        modelInput: prepared.modelInput,
        systemPrompt: prepared.prompt,
        outputSchema: JSON.stringify(prepared.schema),
        configurationJson: prepared.effective
          ? JSON.stringify({
              Model: prepared.effective.request.model,
              Provider: prepared.effective.request.provider.only[0],
              Strategy: prepared.effective.strategy,
              effective: prepared.effective,
            })
          : undefined,
      };
    if (response.error)
      throw Object.assign(new Error(response.error), { code: response.errorCode });
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
    trial.error = {
      code: error.code === "unreviewed_prepared_input" ? error.code : "offline_execution_failed",
      message: error.message,
    };
    trial.elapsedMs = performance.now() - started;
  }
}

export function makeCase(item) {
  return {
    id: item.id,
    dataset: item.dataset,
    split: item.split,
    family: `${item.dataset}/${item.family}`,
    track: "offline-selection",
    category: "external-target",
    instruction: item.instruction,
    review: item.provenance.adaptation ?? {
      status: "source-annotation",
      actionLabel: "unavailable",
    },
    provenance: item.provenance,
    inputKey: item.inputKey,
    expected: {
      outcome: "found",
      actions: [
        {
          step: 1,
          ...(item.action ? { action: item.action } : {}),
          outcome: "found",
          target: { candidateId: item.oracle.candidateId },
        },
      ],
    },
  };
}
