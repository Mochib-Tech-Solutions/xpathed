import { LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Resolution } from "./api";
import ResolutionCost from "./ResolutionCost";
import ResolvedAction from "./ResolvedAction";
import { imageReasons } from "./resolutionPresentation";

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

export type ResolutionMessageProps = {
  resolution: Resolution;
  disabled: boolean;
  resolving: boolean;
  copied: string;
  copyError: { entryId: string; message: string } | null;
  onCopy: (xpath: string, entryId: string) => Promise<void>;
  onRetry: (instruction: string) => void;
  onSpotlight: (resolution: Resolution, actionId: string | null) => void;
  onExecute: (resolution: Resolution, actionId: string, value?: string) => void;
};

export default function ResolutionMessage({
  resolution,
  disabled,
  resolving,
  copied,
  copyError,
  onCopy,
  onRetry,
  onSpotlight,
  onExecute,
}: ResolutionMessageProps) {
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
              onRetry(resolution.instruction);
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
          {resolution.historical && <p className="text-xs text-muted-foreground">Earlier result</p>}
          {resolution.error && (
            <div role="alert" className="text-destructive">
              <h2 className="text-base font-semibold">Request failed</h2>
              <p>{resolution.error}</p>
            </div>
          )}
          {!result && !resolution.error && (
            <p role="status" className="flex items-center gap-2 text-muted-foreground">
              <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
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
                result.summary.unsupported ? `${result.summary.unsupported} unsupported` : "",
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
              <p>{result.diagnostics.message || "The instruction could not be resolved."}</p>
            </div>
          )}
          {actions.map((action) => (
            <ResolvedAction
              key={action.actionId}
              action={action}
              actionCount={actions.length}
              result={result!}
              resolution={resolution}
              disabled={disabled}
              copied={copied}
              copyError={copyError}
              onCopy={onCopy}
              onSpotlight={onSpotlight}
              onExecute={onExecute}
            />
          ))}
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
                <span title="Duration reported by the resolver">Resolution time: {duration}</span>
              )}
              <ResolutionCost diagnostics={result.diagnostics} />
            </>
          )}
        </div>
      </div>
    </article>
  );
}
