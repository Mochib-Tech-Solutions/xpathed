import { ArrowUp, Check, Copy, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Resolution } from "./api";
import ResolutionCost from "./ResolutionCost";

type Props = {
  instruction: string;
  history: Resolution[];
  ready: boolean;
  disabled: boolean;
  resolving: boolean;
  onInstructionChange: (instruction: string) => void;
  onResolve: () => void;
};

export default function ChatPanel({
  instruction,
  history,
  ready,
  disabled,
  resolving,
  onInstructionChange,
  onResolve,
}: Props) {
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState<{ entryId: string; message: string } | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
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
      <div className="flex min-h-14 shrink-0 items-center border-b border-border px-4">
        <h1 className="font-medium">Chat</h1>
      </div>
      <div
        ref={transcript}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
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
                ? "Describe the element you want to find on this page."
                : "Open a website, then describe the element you want to find."}
            </p>
          </div>
        )}
        {history.map((resolution) => {
          const result = resolution.result;
          const target = result?.target;
          const totalMs = result?.diagnostics.timingsMs?.total;
          const duration =
            typeof totalMs === "number" && Number.isFinite(totalMs) && totalMs >= 0
              ? totalMs < 1000
                ? `${Math.round(totalMs)} ms`
                : `${(totalMs / 1000).toFixed(2)} s`
              : null;
          const xpathItem = (xpath: string, index: number) => (
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
                    void copy(xpath, resolution.id);
                  }}
                >
                  {copied === `${resolution.id}:${xpath}` ? (
                    <Check aria-hidden="true" />
                  ) : (
                    <Copy aria-hidden="true" />
                  )}
                </Button>
              </div>
              <code className="block text-sm break-all whitespace-pre-wrap">{xpath}</code>
            </li>
          );
          return (
            <article key={resolution.id} className="mb-6 space-y-3 text-sm leading-relaxed">
              <p className="rounded-xl bg-accent px-3 py-2.5 break-words whitespace-pre-wrap">
                {resolution.instruction}
              </p>
              <div className="space-y-1 text-xs text-muted-foreground">
                <time
                  dateTime={resolution.createdAt}
                  title={new Date(resolution.createdAt).toLocaleString()}
                >
                  {new Date(resolution.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                {resolution.pageTitle && (
                  <p className="font-medium break-words">{resolution.pageTitle}</p>
                )}
                <p className="break-all">{resolution.pageUrl}</p>
                {resolution.historical && <p>Earlier result · no current highlight</p>}
              </div>
              {resolution.error && (
                <p role="alert" className="text-destructive">
                  {resolution.error}
                </p>
              )}
              {!result && !resolution.error && (
                <p className="text-muted-foreground">Waiting for result…</p>
              )}
              {duration && (
                <p
                  className="text-xs text-muted-foreground"
                  title="Duration reported by the resolver"
                >
                  Resolution time: {duration}
                </p>
              )}
              {result && <ResolutionCost diagnostics={result.diagnostics} />}
              {result?.outcome === "not_found" && <p>No matching element found.</p>}
              {result?.outcome === "unsupported" && (
                <div>
                  <p>Unsupported instruction</p>
                  {result?.diagnostics.message && (
                    <p className="text-muted-foreground">{result?.diagnostics.message}</p>
                  )}
                </div>
              )}
              {result?.outcome === "error" && (
                <div role="alert" className="text-destructive">
                  <p>Resolution failed</p>
                  {result?.diagnostics.message && <p>{result?.diagnostics.message}</p>}
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
                      {result?.action} · {target.tag}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground [&>span]:rounded-md [&>span]:border [&>span]:bg-background [&>span]:px-2 [&>span]:py-0.5">
                    <span>{target.state.inViewport ? "In viewport" : "Off-screen"}</span>
                    <span>{target.state.enabled ? "Enabled" : "Disabled"}</span>
                    {(target.state.editable ||
                      result?.action === "fill" ||
                      result?.action === "type") && (
                      <span>{target.state.editable ? "Editable" : "Not editable"}</span>
                    )}
                    {target.state.checked !== null && (
                      <span>{target.state.checked ? "Checked" : "Unchecked"}</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">No action was executed.</p>
                  <details open={!resolution.historical} className="group">
                    <summary className="mb-2 cursor-pointer text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      Verified XPaths
                    </summary>
                    <ol className="space-y-2.5" aria-label="Verified XPath alternatives">
                      {target.xpaths.slice(0, 1).map(xpathItem)}
                    </ol>
                    {target.xpaths.length > 1 && (
                      <details className="mt-3">
                        <summary className="cursor-pointer text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          {target.xpaths.length - 1} alternative XPath
                          {target.xpaths.length > 2 ? "s" : ""}
                        </summary>
                        <ol
                          start={2}
                          className="mt-2 space-y-2.5"
                          aria-label="Additional XPath alternatives"
                        >
                          {target.xpaths
                            .slice(1)
                            .map((xpath, index) => xpathItem(xpath, index + 1))}
                        </ol>
                      </details>
                    )}
                  </details>
                  {copied.startsWith(`${resolution.id}:`) && (
                    <p role="status" className="text-muted-foreground">
                      Copied
                    </p>
                  )}
                  {copyError?.entryId === resolution.id && (
                    <p role="alert" className="text-destructive">
                      {copyError.message}
                    </p>
                  )}
                </>
              )}
            </article>
          );
        })}
        {resolving && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            Resolving…
          </p>
        )}
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
        <div className="flex items-center justify-between gap-3 border-t border-border/60 bg-muted/30 px-3 py-2">
          <p id="instruction-hint" className="min-w-0 text-xs leading-4 text-muted-foreground">
            <span className="block">Enter to send</span>
            <span className="block">Ctrl+Enter for a new line</span>
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
