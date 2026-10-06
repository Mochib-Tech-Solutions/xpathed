// Controlled model output for fixture tests. Expected DOM labels stay in the oracle.
export function controlledActions(provider, candidates, context = []) {
  candidates = candidates.map((candidate) => ({
    ...candidate,
    scope: typeof candidate.scope === "number" ? context[candidate.scope] : candidate.scope,
    frame: typeof candidate.frame === "number" ? context[candidate.frame] : candidate.frame,
  }));
  return provider.actions.map((plan) => {
    const candidate = candidates.filter(
      (item) =>
        (!plan.label || item.label === plan.label || item.text === plan.label) &&
        (!plan.tag || item.tag === plan.tag) &&
        (!plan.scope || item.scope?.includes(plan.scope)) &&
        (!plan.frameLabel ||
          (item.frame?.labels ?? item.frame?.chain?.map((frame) => frame.label))?.includes(
            plan.frameLabel,
          )),
    )[plan.index ?? 0];
    const outcome = plan.outcome === "found" && !candidate ? "not_found" : plan.outcome;
    return {
      step: plan.step,
      instruction: `${plan.action} ${plan.label ?? "requested target"}`,
      action: plan.action,
      outcome,
      candidateId:
        outcome === "found"
          ? provider.fault === "unknown"
            ? "unknown-candidate"
            : candidate.id
          : null,
      limitation: plan.limitation ?? "none",
    };
  });
}
