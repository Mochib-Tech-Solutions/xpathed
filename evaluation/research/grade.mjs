// Both adapters submit the same target-only result shape. Readiness is graded separately.
// Singleton adapters retain their first suggestion; this grader never searches later suggestions.
export function gradeComparison(spec, trial) {
  const labels = spec.expected.actions;
  const actionTypes = new Set(labels.map((item) => item.action));
  if (actionTypes.size !== 1) throw new Error("Comparison cases require one shared action.");
  const expectedAction = labels[0].action;
  const expected = new Set(
    labels.flatMap((item, index) => (item.outcome === "found" ? [index] : [])),
  );
  const failures = [];
  const fail = (category, detail) => failures.push({ category, detail });
  const actions = trial?.result?.actions;
  const metrics = {
    targetsExpected: expected.size,
    targetsReturned: 0,
    targetsCorrect: 0,
    wrongTargets: 0,
    duplicateTargets: 0,
    operationalError: Boolean(trial?.error || trial?.result?.outcome === "error"),
    unsupported: trial?.result?.outcome === "unsupported",
    actionAvailable: typeof trial?.result?.action === "string",
    actionCorrect: trial?.result?.action === expectedAction,
  };
  if (metrics.operationalError) fail("operational", "The adapter failed to produce a resolution.");
  const expectedUnsupported = spec.expected.outcome === "unsupported";
  const correctRefusal =
    expectedUnsupported &&
    trial.strategy === "custom" &&
    metrics.unsupported &&
    metrics.actionCorrect;
  if (expectedUnsupported && !correctRefusal)
    fail("outcome", "Expected an explicit unsupported instruction result.");
  if (metrics.unsupported && !correctRefusal)
    fail("unsupported", "The adapter cannot evaluate this instruction or selector.");
  if (!Array.isArray(actions)) fail("contract", "The adapter did not return target items.");
  if (!["found", "partial", "not_found", "unsupported", "error"].includes(trial?.result?.outcome))
    fail("contract", "The adapter returned an unknown outcome.");
  if (
    !metrics.operationalError &&
    !metrics.unsupported &&
    (metrics.actionAvailable || trial?.result?.outcome !== "not_found") &&
    !metrics.actionCorrect
  )
    fail("action", "The interpreted interaction differs from the instruction label.");
  if (trial?.observation?.passiveStateUnchanged !== true)
    fail(
      "passive_state",
      "Unchanged scroll, focus and field state was not independently verified.",
    );
  if (trial?.observation?.privacyLeak || trial?.observation?.oracleLeak)
    fail("privacy", "Private or oracle information reached strategy evidence.");
  const selected = new Set();
  const correct = new Set();
  for (const [index, item] of (Array.isArray(actions) ? actions : []).entries()) {
    if (!item || !["found", "not_found", "unsupported", "error"].includes(item.outcome))
      fail("contract", "A returned target item is malformed.");
    if (item?.action !== expectedAction)
      fail("action", "A returned item uses a different interaction.");
    if (item?.outcome === "error") {
      metrics.operationalError = true;
      fail("operational", "A target item failed.");
    }
    if (item?.outcome === "unsupported") {
      metrics.unsupported = true;
      if (!correctRefusal) fail("unsupported", "A target item is unsupported.");
    }
    if (item?.outcome !== "found") {
      if (item?.target != null) fail("contract", "A non-found item returned a target.");
      continue;
    }
    metrics.targetsReturned++;
    const match = trial?.observation?.actions?.[index]?.matches;
    const paths = item.target?.xpaths;
    const unique =
      Array.isArray(paths) &&
      paths.length === 1 &&
      typeof paths[0] === "string" &&
      paths[0].trim() &&
      Array.isArray(match) &&
      match.length === 1 &&
      match[0]?.count === 1 &&
      typeof match[0].nodeId === "string" &&
      match[0].nodeId.length > 0;
    const duplicate = unique && selected.has(match[0].nodeId);
    if (unique) selected.add(match[0].nodeId);
    if (duplicate) metrics.duplicateTargets++;
    const indices =
      unique && match[0].eligible === true && Array.isArray(match[0].expectedIndices)
        ? match[0].expectedIndices.filter((value) => expected.has(value))
        : [];
    if (indices.length > 1)
      fail("oracle", "Independent labels identify the same node more than once.");
    if (!unique || indices.length !== 1) metrics.wrongTargets++;
    else if (!duplicate) for (const value of indices) correct.add(value);
  }
  if (trial?.result?.outcome === "partial" && spec.expected.outcome !== "partial")
    fail("outcome", "The adapter reported incomplete resolution.");
  if (metrics.targetsReturned && trial?.result?.outcome === "not_found")
    fail("contract", "A not-found response returned targets.");
  if (!metrics.targetsReturned && trial?.result?.outcome === "found")
    fail("contract", "A found response returned no targets.");
  metrics.targetsCorrect = correct.size;
  metrics.missingTargets = Math.max(0, metrics.targetsExpected - metrics.targetsCorrect);
  metrics.extraTargets = Math.max(0, metrics.targetsReturned - metrics.targetsCorrect);
  metrics.targetSetsComplete = Number(
    !metrics.missingTargets && !metrics.extraTargets && !metrics.duplicateTargets,
  );
  if (!metrics.targetSetsComplete)
    fail("target_identity", "Returned nodes differ from the independently labelled target set.");
  metrics.freshInference = null;
  metrics.reusedResponse =
    trial?.cache?.status === "HIT" ? true : trial?.cache?.status === "DISABLED" ? false : null;
  if (trial?.mode === "live") {
    const forwarded = Array.isArray(trial.provider)
      ? trial.provider.filter((record) => record?.forwarded === true)
      : null;
    const callsKnown =
      Number.isInteger(trial.modelCalls) && trial.modelCalls >= 0 && forwarded !== null;
    if (callsKnown) {
      metrics.freshInference =
        trial.modelCalls === 1 &&
        forwarded.length === 1 &&
        (trial.strategy === "custom" ||
          (trial.strategy === "stagehand" && trial.cache?.status === "DISABLED"));
      if (trial.strategy === "custom" && metrics.freshInference) metrics.reusedResponse = false;
    }
    if (!metrics.operationalError && !metrics.unsupported && metrics.freshInference !== true)
      fail(
        "fresh_inference",
        "One fresh model and provider call with response reuse disabled was not verified.",
      );
  }
  return { passed: failures.length === 0, failures, metrics };
}
