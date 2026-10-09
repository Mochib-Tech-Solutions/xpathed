import { ArrowUp, Check, Copy, Eraser, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { ImageMode, Resolution, ResolutionResult, ShadowHost } from "./api";
import ResolutionCost from "./ResolutionCost";
import ExecuteAction from "./ExecuteAction";

function MessageTime({ value, label }: { value: string; label: string }) {
  const date = new Date(value);
  return (
    <time
      dateTime={value}
      title={`${label} ${date.toLocaleString()}`}
      aria-label={`${label} ${date.toLocaleString()}`}
      className="shrink-0 text-xs text-muted-foreground tabular-nums"
    >
      {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </time>
  );
}

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

function elementType(target: NonNullable<ResolutionResult["target"]>) {
  const names: Record<string, string> = {
    img: "Image",
    button: "Button",
    link: "Link",
    textbox: "Text field",
    searchbox: "Search field",
    combobox: "Dropdown",
    listbox: "List box",
    checkbox: "Checkbox",
    radio: "Radio button",
    spinbutton: "Number field",
    slider: "Slider",
    switch: "Switch",
    tab: "Tab",
    a: "Anchor",
    input: "Input",
    textarea: "Text field",
    select: "Dropdown",
    svg: "Graphic",
    video: "Video",
    audio: "Audio",
    canvas: "Canvas",
    iframe: "Frame",
  };
  const role =
    target.role && !["none", "presentation", "generic"].includes(target.role) ? target.role : null;
  return (
    names[role ?? target.tag] ??
    (role ? role[0]!.toUpperCase() + role.slice(1) : `Element <${target.tag}>`)
  );
}

const interactionReasons: Record<string, string> = {
  disabled: "This element is disabled.",
  readonly: "This field is read-only.",
  incompatible_control: "This control does not support the requested action.",
  off_screen: "This element is off-screen.",
  zero_area: "The target has no area for a pointer interaction.",
  not_visually_rendered: "The target is exposed to accessibility but is not visually rendered.",
  pointer_events_none: "The target does not receive pointer events at the inspected point.",
  obstructed_at_hit_point: "Another element or clipping blocks the inspected pointer point.",
  custom_control_unverified: "Interaction with this custom control could not be verified.",
  ancestor_frame_obstructed: "An overlay or clipping blocks the target’s containing frame.",
};

const instructionLimits: Record<string, string> = {
  ambiguous:
    "The instruction does not identify a unique target. Specify its exact name, section, or position, such as left or right.",
  current_state_dependency:
    "This element depends on a page change. Make that change, then try again.",
  unsupported_action: "This interaction is not supported.",
};

const instructionTitles: Record<string, string> = {
  ambiguous: "Ambiguous target",
  unsupported_action: "Unsupported interaction",
  current_state_dependency: "Page change required",
  appearance_unavailable: "Appearance unavailable",
  unsupported_scope: "Unsupported page content",
};

const imageReasons: Record<string, string> = {
  text_only_requested: "You chose text only.",
  no_candidates: "There were no captured elements to inspect.",
  semantic_evidence: "Page text and structure appeared sufficient.",
  visual_evidence: "An image was chosen to help with visual details.",
  uncertain_route: "A screenshot could help clarify the available evidence.",
  router_unavailable: "The automatic image decision was unavailable.",
  image_unavailable: "A usable screenshot was unavailable.",
};

type Props = {
  instruction: string;
  imageMode: ImageMode;
  onImageModeChange: (imageMode: ImageMode) => void;
  history: Resolution[];
  ready: boolean;
  disabled: boolean;
  resolving: boolean;
  resetDisabled: boolean;
  onInstructionChange: (instruction: string) => void;
  onResolve: (instruction?: string) => void;
  onReset: () => void;
  onSpotlight: (resolution: Resolution, actionId: string | null) => void;
  onExecute: (resolution: Resolution, actionId: string, value?: string) => void;
};

export default function ChatPanel({
  instruction,
  imageMode,
  onImageModeChange,
  history,
  ready,
  disabled,
  resolving,
  resetDisabled,
  onInstructionChange,
  onResolve,
  onReset,
  onSpotlight,
  onExecute,
}: Props) {
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState<{ entryId: string; message: string } | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const resetConfirmed = useRef(false);
  const restoreFocus = useRef(false);
  const transcript = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  useEffect(() => {
    if (followBottom.current && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [history]);
  useEffect(() => {
    if (resolving || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (
      !disabled &&
      (document.activeElement === document.body ||
        composer.current?.form?.contains(document.activeElement))
    ) {
      composer.current?.focus({ preventScroll: true });
    }
  }, [disabled, resolving]);
  const tooLong = instruction.trim().length > 4000;

  async function copy(xpath: string, entryId: string) {
    try {
      await navigator.clipboard.writeText(xpath);
      setCopied(`${entryId}:${xpath}`);
      setCopyError(null);
    } catch {
      setCopyError({ entryId, message: "Unable to copy. Select and copy the XPath manually." });
    }
  }

  return (
    <aside
      className="flex h-[42%] min-h-56 min-w-0 flex-col border-t border-border bg-muted/40 sm:h-auto sm:min-h-0 sm:border-t-0 sm:border-r"
      aria-label="Chat"
    >
      <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <h1 className="font-medium">Chat</h1>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              aria-label="Reset chat"
              title="Reset chat"
              disabled={resetDisabled || (!history.length && !instruction)}
            >
              <Eraser aria-hidden="true" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent
            onCloseAutoFocus={(event) => {
              if (!resetConfirmed.current) return;
              event.preventDefault();
              resetConfirmed.current = false;
              composer.current?.focus();
            }}
          >
            <AlertDialogTitle>Reset chat?</AlertDialogTitle>
            <AlertDialogDescription>
              This tab’s draft and chat history will be cleared.
            </AlertDialogDescription>
            <div className="mt-3 flex justify-end gap-2">
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={resetDisabled}
                onClick={() => {
                  onReset();
                  resetConfirmed.current = true;
                  followBottom.current = true;
                  setCopied("");
                  setCopyError(null);
                }}
              >
                Reset chat
              </AlertDialogAction>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <div
        ref={transcript}
        className="min-h-0 flex-1 [scrollbar-width:thin] [scrollbar-color:var(--input)_transparent] overflow-y-auto px-3 py-4"
        role="log"
        aria-label="Chat history"
        aria-live="polite"
        onScroll={(event) => {
          const element = event.currentTarget;
          followBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 64;
        }}
      >
        {!history.length && !resolving && (
          <div className="flex h-full flex-col justify-center gap-2 text-sm leading-relaxed">
            <h2 className="text-base font-medium">Find an element</h2>
            <p className="text-muted-foreground">
              {ready
                ? "Describe the element you want to find in the current view."
                : "Open a website, then describe the element you want to find."}
            </p>
          </div>
        )}
        {history.map((resolution) => {
          const result = resolution.result;
          const actions = result?.actions ?? [];
          const imageRouting = result?.diagnostics.imageRouting;
          const imageStatus =
            imageRouting?.status === "included"
              ? "Image used"
              : imageRouting?.status === "unavailable"
                ? "Image unavailable"
                : "Text only";
          const imageReason = imageRouting
            ? (imageReasons[imageRouting.reason] ?? "Image use was decided for this request.")
            : "";
          const totalMs = result?.diagnostics.timingsMs?.total;
          const duration =
            typeof totalMs === "number" && Number.isFinite(totalMs) && totalMs >= 0
              ? totalMs < 1000
                ? `${Math.round(totalMs)} ms`
                : `${(totalMs / 1000).toFixed(2)} s`
              : null;
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
                    void copy(xpath, `${resolution.id}:${actionId}`);
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
            <article key={resolution.id} className="mb-6 space-y-4 text-sm leading-relaxed">
              <div className="ml-6 flex flex-col items-end gap-1.5" aria-label="Sent message">
                <div className="flex max-w-full items-center gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-muted-foreground"
                    aria-label="Retry instruction"
                    title="Retry instruction"
                    disabled={disabled || resolving}
                    onClick={() => {
                      followBottom.current = true;
                      setCopied("");
                      setCopyError(null);
                      onResolve(resolution.instruction);
                    }}
                  >
                    <RotateCcw aria-hidden="true" />
                  </Button>
                  <p className="min-w-0 rounded-2xl rounded-br-sm bg-accent px-3.5 py-2.5 break-words whitespace-pre-wrap">
                    {resolution.instruction}
                  </p>
                </div>
                <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                  <span>You</span>
                  <MessageTime value={resolution.createdAt} label="Sent" />
                </div>
              </div>
              <div className="mr-2 min-w-0 space-y-1.5" aria-label="Response message">
                <p className="px-1 font-serif text-sm font-normal tracking-[-0.03em] text-muted-foreground">
                  xpathed
                </p>
                <div className="space-y-3 rounded-2xl rounded-tl-sm border border-border bg-background p-3.5 shadow-sm">
                  {resolution.historical && (
                    <p className="text-xs text-muted-foreground">Earlier result</p>
                  )}
                  {resolution.error && (
                    <div role="alert" className="text-destructive">
                      <h2 className="text-base font-semibold">Request failed</h2>
                      <p>{resolution.error}</p>
                    </div>
                  )}
                  {!result && !resolution.error && (
                    <p role="status" className="flex items-center gap-2 text-muted-foreground">
                      <LoaderCircle
                        className="size-3.5 motion-safe:animate-spin"
                        aria-hidden="true"
                      />
                      Resolving…
                    </p>
                  )}
                  {result?.outcome === "partial" && (
                    <h2 className="text-base font-semibold">Partial result</h2>
                  )}
                  {result?.summary && actions.length > 1 && (
                    <p className="text-xs text-muted-foreground">
                      {[
                        `${result.summary.found} target${result.summary.found === 1 ? "" : "s"} found`,
                        result.summary.notFound ? `${result.summary.notFound} missing` : "",
                        result.summary.unsupported
                          ? `${result.summary.unsupported} unsupported`
                          : "",
                        result.summary.errors ? `${result.summary.errors} failed` : "",
                        result.summary.blocked ? `${result.summary.blocked} blocked` : "",
                        "current view",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                  {actions.length > 1 && result?.action && result?.action !== "unsupported" && (
                    <p className="w-fit rounded-md bg-accent px-2 py-1 text-xs font-medium">
                      Action: {result?.action.replaceAll("_", "-")}
                    </p>
                  )}
                  {result?.outcome === "error" && !actions.length && (
                    <div role="alert" className="text-destructive">
                      <h2 className="text-base font-semibold">
                        {result.diagnostics.code === "decomposition_incomplete"
                          ? "Incomplete response"
                          : "Resolution failed"}
                      </h2>
                      <p>
                        {result.diagnostics.message || "The instruction could not be resolved."}
                      </p>
                    </div>
                  )}
                  {actions.map((action) => {
                    const target = action.target;
                    if (target?.interactability?.status === "blocked") {
                      const reason = target.interactability.reasons.find(
                        (reason) => interactionReasons[reason],
                      );
                      return (
                        <section
                          key={action.actionId}
                          aria-label={`Target ${action.order}`}
                          className={
                            actions.length > 1
                              ? "space-y-3 rounded-xl border border-border bg-muted/20 p-3"
                              : "space-y-3"
                          }
                        >
                          {actions.length > 1 && (
                            <p className="text-xs font-medium text-muted-foreground">
                              Target {action.order}
                            </p>
                          )}
                          <p className="text-destructive">
                            Cannot {action.action?.replaceAll("_", "-") ?? "interact with"}{" "}
                            <bdi>
                              {(target.accessibleName ?? target.label)
                                ? `“${target.accessibleName ?? target.label}”`
                                : `the unnamed ${elementType(target).toLowerCase()}`}
                            </bdi>
                            .{" "}
                            {reason
                              ? interactionReasons[reason]
                              : "The requested action is blocked."}
                          </p>
                        </section>
                      );
                    }
                    const checks = target?.interactability?.checks;
                    const verified = [
                      checks?.compatibleControl === "pass" &&
                        !["click", "double_click", "right_click", "hover", "inspect"].includes(
                          action.action ?? "",
                        ) &&
                        "compatible control type",
                      checks?.enabled === "pass" && "enabled",
                      checks?.writable === "pass" && "not read-only",
                      checks?.viewport === "pass" && "in view",
                      checks?.pointerReception === "pass" && "unobstructed at the checked point",
                    ]
                      .filter(Boolean)
                      .join(", ");
                    return (
                      <section
                        key={action.actionId}
                        className={
                          actions.length > 1
                            ? "space-y-3 rounded-xl border border-border bg-muted/20 p-3"
                            : "space-y-3"
                        }
                        aria-label={`Target ${action.order}`}
                      >
                        {actions.length > 1 && (
                          <p className="text-xs font-medium text-muted-foreground">
                            Target {action.order}
                          </p>
                        )}
                        {actions.length > 1 && !target && (
                          <p className="text-xs font-medium text-muted-foreground">
                            {action.order}. {action.instruction}
                          </p>
                        )}
                        {target && (
                          <div className="space-y-1">
                            <h2 className="text-base font-semibold break-words">
                              {elementType(target)}
                            </h2>
                            {(target.accessibleName ?? target.label) ? (
                              <p className="break-words">
                                <bdi>{target.accessibleName ?? target.label}</bdi>
                              </p>
                            ) : (
                              <p className="text-xs text-muted-foreground">No accessible name</p>
                            )}
                          </div>
                        )}
                        {action.action &&
                          action.action !== "unsupported" &&
                          actions.length === 1 && (
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
                            <p>
                              {action.code === "ambiguous" ||
                              action.code === "current_state_dependency"
                                ? instructionLimits[action.code]
                                : (action.message ??
                                  instructionLimits[action.code ?? ""] ??
                                  "This instruction cannot be resolved within the supported scope.")}
                            </p>
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
                                  Frame:{" "}
                                  {target.frame.chain
                                    .map((frame) => frame.label || frame.frameId)
                                    .join(" → ")}
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
                            {target.xpaths[0] &&
                              xpathItem(target.xpaths[0], action.actionId, action.order)}
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
                                  {interactionReasons[reason] ??
                                    "An interaction limitation was observed."}
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
                                    <span>
                                      {target.state.inViewport ? "In viewport" : "Off-screen"}
                                    </span>
                                  )}
                                  {checks?.enabled !== "pass" &&
                                    (checks?.enabled !== "not_applicable" ||
                                      !target.state.enabled) && (
                                      <span>{target.state.enabled ? "Enabled" : "Disabled"}</span>
                                    )}
                                  {(target.state.editable ||
                                    action.action === "fill" ||
                                    action.action === "type") && (
                                    <span>
                                      {target.state.editable ? "Editable" : "Not editable"}
                                    </span>
                                  )}
                                  {target.state.checked !== null && (
                                    <span>{target.state.checked ? "Checked" : "Unchecked"}</span>
                                  )}
                                  {target.state.selected != null && (
                                    <span>
                                      {target.state.selected ? "Selected" : "Not selected"}
                                    </span>
                                  )}
                                  {target.state.selectedOptionCount != null && (
                                    <span>{target.state.selectedOptionCount} options selected</span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </>
                        )}
                      </section>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-muted-foreground">
                  {resolution.respondedAt && (
                    <MessageTime value={resolution.respondedAt} label="Received" />
                  )}
                  {result && (
                    <>
                      {imageRouting && (
                        <span title={imageReason} aria-label={`${imageStatus}: ${imageReason}`}>
                          {imageStatus}
                        </span>
                      )}
                      {duration && (
                        <span title="Duration reported by the resolver">
                          Resolution time: {duration}
                        </span>
                      )}
                      <ResolutionCost diagnostics={result.diagnostics} />
                    </>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      <form
        className="m-3 shrink-0 overflow-hidden rounded-xl border border-input bg-background shadow-sm transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled && !resolving && !tooLong && instruction.trim()) {
            setCopied("");
            setCopyError(null);
            restoreFocus.current = true;
            onResolve();
          }
        }}
      >
        <p id="instruction-scope" className="px-3 pt-2 text-xs text-muted-foreground">
          Current view only
        </p>
        <label className="mx-3 mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          Screenshots
          <select
            value={imageMode}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === "auto" || value === "text_only") onImageModeChange(value);
            }}
            disabled={disabled || resolving}
            aria-describedby="screenshot-sharing"
            className="rounded-md border border-input bg-background px-2 py-1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="auto">Auto</option>
            <option value="text_only">Text only</option>
          </select>
        </label>
        <p id="screenshot-sharing" className="px-3 pt-1 text-xs text-muted-foreground">
          {imageMode === "auto"
            ? "Auto sends a masked screenshot to the model provider when visual details may help. Other visible content can be shared."
            : "Text only sends page text and structure, without screenshots."}
        </p>
        <textarea
          ref={composer}
          className="block [field-sizing:content] max-h-40 min-h-[72px] w-full min-w-0 resize-none border-0 bg-transparent px-3 pt-3 pb-2 text-base leading-6 outline-none placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          aria-label="Describe an element"
          aria-invalid={tooLong}
          aria-describedby={
            tooLong
              ? "instruction-error instruction-scope instruction-hint"
              : "instruction-scope instruction-hint"
          }
          placeholder={ready ? "Describe an element…" : "Open a website to begin…"}
          rows={2}
          value={instruction}
          onChange={(event) => onInstructionChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229 ||
              event.altKey ||
              event.metaKey
            )
              return;
            if (event.ctrlKey) {
              event.preventDefault();
              const field = event.currentTarget;
              field.setRangeText("\n", field.selectionStart, field.selectionEnd, "end");
              onInstructionChange(field.value);
            } else if (!event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          disabled={disabled}
        />
        {tooLong && (
          <p id="instruction-error" role="alert" className="px-3 pb-2 text-xs text-destructive">
            Use 4,000 characters or fewer.
          </p>
        )}
        <div className="flex items-center justify-between gap-3 px-3 pb-2">
          <p id="instruction-hint" className="min-w-0 text-xs leading-4 text-muted-foreground">
            Enter to send · Ctrl+Enter for a new line
          </p>
          <Button
            type="submit"
            size="icon"
            className="size-8 rounded-lg"
            aria-label="Resolve instruction"
            disabled={disabled || resolving || tooLong || !instruction.trim()}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
        </div>
      </form>
    </aside>
  );
}
