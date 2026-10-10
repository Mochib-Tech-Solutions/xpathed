import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ActionResolution, ResolutionResult, ShadowHost } from "./api";
import ExecuteAction from "./ExecuteAction";
import {
  elementType,
  instructionLimit,
  instructionTitles,
  interactionReasons,
} from "./resolutionPresentation";
import type { ResolutionMessageProps } from "./ResolutionMessage";

function ShadowContext({ chain }: { chain?: ShadowHost[] | null }) {
  if (!chain?.length) return null;
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>
        Shadow roots: {chain.map((host, index) => host.label || `Root ${index + 1}`).join(" → ")}
      </p>
      {chain.map((host, index) => (
        <code key={index} className="block break-all">
          {host.xpath}
        </code>
      ))}
      <p>Evaluate the next XPath inside the final shadow root.</p>
    </div>
  );
}

type Props = Pick<
  ResolutionMessageProps,
  "resolution" | "disabled" | "copied" | "copyError" | "onCopy" | "onSpotlight" | "onExecute"
> & {
  action: ActionResolution;
  actionCount: number;
  result: ResolutionResult;
};

export default function ResolvedAction({
  resolution,
  disabled,
  copied,
  copyError,
  onCopy,
  onSpotlight,
  onExecute,
  action,
  actionCount,
  result,
}: Props) {
  const imageRouting = result.diagnostics.imageRouting;
  const target = action.target;
  const blocked = target?.interactability?.status === "blocked";
  const blockingReason = target?.interactability?.reasons.find(
    (reason) => interactionReasons[reason],
  );
  const checks = target?.interactability?.checks;
  const verified = [
    checks?.compatibleControl === "pass" &&
      !["click", "double_click", "right_click", "hover", "inspect"].includes(action.action ?? "") &&
      "compatible control type",
    checks?.enabled === "pass" && "enabled",
    checks?.writable === "pass" && "not read-only",
    checks?.viewport === "pass" && "in view",
    checks?.pointerReception === "pass" && "unobstructed at the checked point",
  ]
    .filter(Boolean)
    .join(", ");
  const xpathItem = (xpath: string, actionId: string, order: number) => (
    <div className="min-w-0 rounded-lg border border-border/70 bg-muted/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">XPath</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="-my-1 size-7"
          aria-label={`Copy XPath ${order}`}
          onClick={() => {
            void onCopy(xpath, `${resolution.id}:${actionId}`);
          }}
        >
          {copied === `${resolution.id}:${actionId}:${xpath}` ? (
            <Check aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
        </Button>
      </div>
      <code
        className="block rounded-sm text-sm break-all whitespace-pre-wrap focus-visible:outline-2 focus-visible:outline-ring"
        tabIndex={!resolution.historical && !disabled ? 0 : undefined}
        onMouseEnter={() => onSpotlight(resolution, actionId)}
        onMouseLeave={(event) => {
          if (document.activeElement !== event.currentTarget) onSpotlight(resolution, null);
        }}
        onFocus={() => onSpotlight(resolution, actionId)}
        onBlur={(event) => {
          if (!event.currentTarget.matches(":hover")) onSpotlight(resolution, null);
        }}
        title={resolution.historical ? undefined : "Spotlight this target"}
      >
        {xpath}
      </code>
    </div>
  );
  return (
    <section
      className={
        actionCount > 1 ? "space-y-3 rounded-xl border border-border bg-muted/20 p-3" : "space-y-3"
      }
      aria-label={`Target ${action.order}`}
    >
      {actionCount > 1 && (
        <p className="text-xs font-medium text-muted-foreground">Target {action.order}</p>
      )}
      {actionCount > 1 && !target && (
        <p className="text-xs font-medium text-muted-foreground">
          {action.order}. {action.instruction}
        </p>
      )}
      {target && (
        <div className="space-y-1">
          <h2 className="text-base font-semibold break-words">{elementType(target)}</h2>
          {(target.accessibleName ?? target.label) ? (
            <p className="break-words">
              <bdi>{target.accessibleName ?? target.label}</bdi>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">No accessible name</p>
          )}
          {!blocked &&
            action.instruction &&
            (actionCount > 1 ||
              (!(target.accessibleName ?? target.label) &&
                (target.role === "img" ||
                  ["img", "svg", "canvas", "video"].includes(target.tag)))) && (
              <p className="text-xs text-muted-foreground">
                Requested: <bdi>{action.instruction}</bdi>
              </p>
            )}
        </div>
      )}
      {action.action && action.action !== "unsupported" && actionCount === 1 && (
        <p className="w-fit rounded-md bg-accent px-2 py-1 text-xs font-medium">
          Action: {result?.action?.replaceAll("_", "-")}
        </p>
      )}
      {action.outcome === "not_found" && (
        <>
          <h2 className="text-base font-semibold">Target not found</h2>
          <p>I couldn’t find that element in the current view.</p>
        </>
      )}
      {action.outcome === "unsupported" && (
        <>
          <h2 className="text-base font-semibold">
            {instructionTitles[action.code ?? ""] ?? "Unsupported instruction"}
          </h2>
          <p>{instructionLimit(action, imageRouting)}</p>
        </>
      )}
      {action.outcome === "error" && (
        <div role="alert" className="text-destructive">
          <h2 className="text-base font-semibold">Resolution failed</h2>
          <p>{action.message || "This target could not be resolved."}</p>
        </div>
      )}
      {target && (
        <>
          {!!target.frame?.chain.length && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>
                Frame: {target.frame.chain.map((frame) => frame.label || frame.frameId).join(" → ")}
              </p>
              {target.frame.chain.map((frame) => (
                <div key={frame.frameId}>
                  <ShadowContext chain={frame.shadowChain} />
                  <code className="block break-all">{frame.xpath}</code>
                </div>
              ))}
            </div>
          )}
          <ShadowContext chain={target.shadowChain} />
          {target.xpaths[0] && xpathItem(target.xpaths[0], action.actionId, action.order)}
          {copied.startsWith(`${resolution.id}:${action.actionId}:`) && (
            <p role="status" className="text-muted-foreground">
              Copied
            </p>
          )}
          {copyError?.entryId === `${resolution.id}:${action.actionId}` && (
            <p role="alert" className="text-destructive">
              {copyError.message}
            </p>
          )}
          {blocked ? (
            <p className="text-destructive">
              Cannot {action.action?.replaceAll("_", "-") ?? "interact with"}{" "}
              <bdi>
                {(target.accessibleName ?? target.label)
                  ? `“${target.accessibleName ?? target.label}”`
                  : `the unnamed ${elementType(target).toLowerCase()}`}
              </bdi>
              .{" "}
              {blockingReason
                ? interactionReasons[blockingReason]
                : "The requested action is blocked."}
            </p>
          ) : (
            <>
              <ExecuteAction
                entry={resolution}
                action={action}
                disabled={disabled}
                onExecute={onExecute}
              />
              <div className="space-y-2 border-t border-border/70 pt-3">
                <h3 className="text-xs font-medium">Verification</h3>
                {target.interactability?.reasons.map((reason) => (
                  <p key={reason} className="text-muted-foreground">
                    {interactionReasons[reason] ?? "An interaction limitation was observed."}
                  </p>
                ))}
                <div className="space-y-2 text-xs text-muted-foreground">
                  {verified && <p>Verified: {verified}.</p>}
                  {(target.interactability?.status !== "ready" ||
                    (!verified && action.action !== "inspect")) && (
                    <p>
                      {target.interactability?.status === "ready"
                        ? "Detailed interaction checks are unavailable."
                        : target.interactability?.status === "unsupported"
                          ? "Interaction assessment unsupported."
                          : target.interactability?.status === "unknown"
                            ? checks?.keyboard === "unknown"
                              ? "Keyboard readiness unknown."
                              : "Interaction readiness unknown."
                            : "Interaction readiness unavailable."}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {checks?.viewport !== "pass" && (
                      <span>{target.state.inViewport ? "In viewport" : "Off-screen"}</span>
                    )}
                    {checks?.enabled !== "pass" &&
                      (checks?.enabled !== "not_applicable" || !target.state.enabled) && (
                        <span>{target.state.enabled ? "Enabled" : "Disabled"}</span>
                      )}
                    {(target.state.editable ||
                      action.action === "fill" ||
                      action.action === "type") && (
                      <span>{target.state.editable ? "Editable" : "Not editable"}</span>
                    )}
                    {target.state.checked !== null && (
                      <span>{target.state.checked ? "Checked" : "Unchecked"}</span>
                    )}
                    {target.state.selected != null && (
                      <span>{target.state.selected ? "Selected" : "Not selected"}</span>
                    )}
                    {target.state.selectedOptionCount != null && (
                      <span>{target.state.selectedOptionCount} options selected</span>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
