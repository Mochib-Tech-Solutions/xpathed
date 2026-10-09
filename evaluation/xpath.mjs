import { isDeepStrictEqual } from "node:util";
import { controlledActions } from "./fixtures/selection.mjs";
import { command, request, main } from "./run.mjs";

export function selectXPathCases(cases) {
  const selected = [],
    exclusions = [];
  for (const spec of cases) {
    const reason =
      spec.provider?.fault || spec.expected?.outcome === "error"
        ? "provider or Resolver error coverage"
        : !spec.expected.actions.some((action) => action.outcome === "found")
          ? "no selected target to construct an XPath for"
          : null;
    if (reason) exclusions.push({ caseId: spec.id, reason });
    else {
      // Summary/action interpretation are Resolver responsibilities. Keep target and state labels.
      const { summary, ...expected } = spec.expected;
      const mutation = spec.mutation && {
        ...spec.mutation,
        afterExpected: Object.fromEntries(
          Object.entries(spec.mutation.afterExpected).filter(([key]) => key !== "summary"),
        ),
      };
      selected.push({ ...spec, track: "xpath", expected, ...(mutation ? { mutation } : {}) });
    }
  }
  return { cases: selected, exclusions };
}

export function verifiedFrameMatches(captured, verified) {
  if (!captured || !verified) return false;
  if (
    !(verified.chain ?? []).every(
      (owner) =>
        typeof owner.xpath === "string" &&
        owner.xpath.trim() &&
        (owner.shadowChain ?? []).every(
          (host) => typeof host.xpath === "string" && host.xpath.trim(),
        ),
    )
  )
    return false;
  const identity = ({ chain, ...frame }) => ({
    ...frame,
    chain: chain?.map(({ xpath, shadowChain, ...owner }) => ({
      ...owner,
      shadowChain: shadowChain?.map(({ xpath, ...host }) => host),
    })),
  });
  return isDeepStrictEqual(identity(captured), identity(verified));
}

export async function resolveXPathTrial(spec, trial, session, page, options, services, channelId) {
  const started = performance.now();
  try {
    const capture = await request(
      `${services.browser}/pages/${session.pageId}/capture`,
      { documentId: page.documentId, scope: "current_view" },
      options.timeoutMs,
    );
    if (
      capture.pageId !== session.pageId ||
      capture.documentId !== page.documentId ||
      capture.scope !== "current_view"
    )
      throw new Error("XPath capture identity or scope mismatch");
    const selections = controlledActions(spec.provider, capture.candidates);
    const actions = selections.map((item, index) => ({
      actionId: `a${index + 1}`,
      candidateId: item.candidateId,
      action: item.action,
    }));
    const validation = await request(
      `${services.resolver}/pages/${session.pageId}/selections`,
      { documentId: page.documentId, captureId: capture.captureId, actions },
      options.timeoutMs,
    );
    trial.elapsedMs = performance.now() - started;
    trial.evidence = { capture, selections, browserValidation: validation };
    if (validation.actions?.length !== actions.length)
      throw new Error("XPath validation action count mismatch");
    for (const [index, verified] of validation.actions.entries()) {
      const selected = actions[index];
      const candidate = capture.candidates.find((item) => item.id === selected.candidateId);
      if (
        verified.actionId !== selected.actionId ||
        (selected.candidateId === null
          ? verified.target !== null
          : verified.target?.candidateId !== selected.candidateId ||
            !verifiedFrameMatches(candidate?.frame, verified.target?.frame))
      )
        throw new Error("XPath verification returned a different selection or frame");
    }
    // Grader adapter only: retain the verification response above; no model call was made.
    const outcomes = [...new Set(selections.map((item) => item.outcome))];
    trial.result = {
      outcome: outcomes.length === 1 ? outcomes[0] : "partial",
      action: selections[0].action,
      attemptId: trial.id,
      pageId: session.pageId,
      documentId: page.documentId,
      captureId: capture.captureId,
      diagnostics: { modelCalls: 0 },
      actions: selections.map((item, index) => ({
        ...item,
        actionId: actions[index].actionId,
        order: index + 1,
        diagnosticsReference: trial.id,
        target: validation.actions[index].target,
      })),
    };
    trial.provider = [];
    trial.observation = await command(
      services.fixture,
      channelId,
      {
        kind: "observe",
        expected: spec.expected.actions.map((item) => item.target ?? null),
        actions: trial.result.actions,
      },
      options.timeoutMs,
    );
    trial.observation.captureCoverage = trial.captureObservation?.captureCoverage ?? null;
    trial.observation.modelInputCoverage = null;
    if (
      Math.abs(trial.observation.viewport.width - spec.viewport.width) >
        (spec.viewport.tolerance ?? 0) ||
      Math.abs(trial.observation.viewport.height - spec.viewport.height) >
        (spec.viewport.tolerance ?? 0)
    )
      throw new Error("Fixture viewport does not match the manifest");
  } catch (error) {
    trial.error = { code: error.code ?? error.name, message: error.message };
  } finally {
    trial.elapsedMs ??= performance.now() - started;
  }
}

if (import.meta.main)
  main(process.argv.slice(2), "xpath")
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 2;
    });
