import type { ActionResolution, Resolution } from "./api";

export const needsExecutionValue = (action: string) =>
  ["fill", "type", "select", "press"].includes(action);

export function canExecute(entry: Resolution, action: ActionResolution) {
  const target = action.target;
  const readiness = target?.interactability;
  return (
    !entry.historical &&
    !entry.execution &&
    !!entry.result?.captureId &&
    !!entry.result.sessionId &&
    action.outcome === "found" &&
    [
      "click",
      "double_click",
      "right_click",
      "hover",
      "fill",
      "type",
      "clear",
      "select",
      "check",
      "uncheck",
      "press",
      "focus",
      "blur",
    ].includes(action.action) &&
    !!target?.state.rendered &&
    target.state.inViewport &&
    !!readiness &&
    readiness.status !== "blocked" &&
    readiness.status !== "unsupported" &&
    readiness.checks.compatibleControl === "pass" &&
    (!["fill", "type", "clear"].includes(action.action) || readiness.checks.keyboard === "pass")
  );
}
