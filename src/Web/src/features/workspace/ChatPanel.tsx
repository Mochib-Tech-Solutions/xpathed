import { ArrowUp, Check, Copy, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Resolution } from "./api";

type Props = {
  instruction: string;
  resolution: Resolution | null;
  ready: boolean;
  disabled: boolean;
  resolving: boolean;
  onInstructionChange: (instruction: string) => void;
  onResolve: () => void;
};

export default function ChatPanel({
  instruction,
  resolution,
  ready,
  disabled,
  resolving,
  onInstructionChange,
  onResolve,
}: Props) {
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState("");
  const composer = useRef<HTMLTextAreaElement>(null);
  const restoreFocus = useRef(false);
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
  const target = resolution?.result.target;
  const tooLong = instruction.trim().length > 4000;
  const totalMs = resolution?.result.diagnostics.timingsMs?.total;
  const duration =
    typeof totalMs === "number" && Number.isFinite(totalMs) && totalMs >= 0
      ? totalMs < 1000
        ? `${Math.round(totalMs)} ms`
        : `${(totalMs / 1000).toFixed(2)} s`
      : null;

  async function copy(xpath: string) {
    try {
      await navigator.clipboard.writeText(xpath);
      setCopied(xpath);
      setCopyError("");
    } catch {
      setCopyError("Unable to copy. Select and copy the XPath manually.");
    }
  }

  return (
    <aside
      className="flex h-[42%] min-h-56 min-w-0 flex-col border-t border-border bg-muted/40 sm:h-auto sm:min-h-0 sm:border-t-0 sm:border-r"
      aria-label="Chat"
    >
      <div className="flex min-h-14 shrink-0 items-center border-b border-border px-4">
        <h1 className="font-medium">Chat</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
        {!resolution && !resolving && (
          <div className="flex h-full flex-col justify-center gap-2 text-sm leading-relaxed">
            <h2 className="text-base font-medium">Find an element</h2>
            <p className="text-muted-foreground">
              {ready
                ? "Describe the element you want to find on this page."
                : "Open a website, then describe the element you want to find."}
            </p>
          </div>
        )}
        {resolution && (
          <div className="space-y-4 text-sm leading-relaxed">
            <p className="rounded-xl bg-accent px-3 py-2.5 break-words whitespace-pre-wrap">
              {resolution.instruction}
            </p>
            {duration && (
              <p
                className="text-xs text-muted-foreground"
                title="Duration reported by the resolver"
              >
                Resolution time: {duration}
              </p>
            )}
            {resolution.result.outcome === "not_found" && <p>No matching element found.</p>}
            {resolution.result.outcome === "unsupported" && (
              <div>
                <p>Unsupported instruction</p>
                {resolution.result.diagnostics.message && (
                  <p className="text-muted-foreground">{resolution.result.diagnostics.message}</p>
                )}
              </div>
            )}
            {resolution.result.outcome === "error" && (
              <div role="alert" className="text-destructive">
                <p>Resolution failed</p>
                {resolution.result.diagnostics.message && (
                  <p>{resolution.result.diagnostics.message}</p>
                )}
              </div>
            )}
            {target && (
              <>
                <div>
                  <p className="mb-1 flex items-center gap-1.5 font-medium">
                    <Check className="size-3.5" aria-hidden="true" /> Target found
                  </p>
                  <h2 className="text-base font-medium break-words">
                    {target.label || target.tag}
                  </h2>
                  <p className="text-muted-foreground">
                    {resolution.result.action} · {target.tag}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground [&>span]:rounded-md [&>span]:border [&>span]:bg-background [&>span]:px-2 [&>span]:py-0.5">
                  <span>{target.state.inViewport ? "In viewport" : "Off-screen"}</span>
                  <span>{target.state.enabled ? "Enabled" : "Disabled"}</span>
                  {(target.state.editable ||
                    resolution.result.action === "fill" ||
                    resolution.result.action === "type") && (
                    <span>{target.state.editable ? "Editable" : "Not editable"}</span>
                  )}
                  {target.state.checked !== null && (
                    <span>{target.state.checked ? "Checked" : "Unchecked"}</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">No action was executed.</p>
                <ol className="space-y-2.5" aria-label="Verified XPath alternatives">
                  {target.xpaths.map((xpath, index) => (
                    <li key={xpath} className="rounded-lg border border-border bg-background p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-muted-foreground">
                          {index === 0 ? "Primary XPath" : `Alternative ${index}`}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="-my-1 size-7"
                          aria-label={`Copy XPath ${index + 1}`}
                          onClick={() => {
                            void copy(xpath);
                          }}
                        >
                          {copied === xpath ? (
                            <Check aria-hidden="true" />
                          ) : (
                            <Copy aria-hidden="true" />
                          )}
                        </Button>
                      </div>
                      <code className="block text-sm break-all whitespace-pre-wrap">{xpath}</code>
                    </li>
                  ))}
                </ol>
                {copied && (
                  <p role="status" className="text-muted-foreground">
                    Copied
                  </p>
                )}
                {copyError && (
                  <p role="alert" className="text-destructive">
                    {copyError}
                  </p>
                )}
              </>
            )}
          </div>
        )}
        {resolving && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            Resolving…
          </p>
        )}
      </div>
      <form
        className="mx-4 mb-4 shrink-0 rounded-xl border border-input bg-background shadow-sm transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled && !resolving && !tooLong && instruction.trim()) {
            setCopied("");
            setCopyError("");
            restoreFocus.current = true;
            onResolve();
          }
        }}
      >
        <textarea
          ref={composer}
          className="block [field-sizing:content] max-h-40 min-h-[72px] w-full min-w-0 resize-none border-0 bg-transparent px-3 pt-3 pb-2 text-base leading-6 outline-none placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          aria-label="Describe an element"
          aria-invalid={tooLong}
          aria-describedby={tooLong ? "instruction-error instruction-hint" : "instruction-hint"}
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
        <div className="flex items-center justify-between gap-2 px-3 pb-2">
          <p id="instruction-hint" className="text-xs text-muted-foreground">
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
