import { ArrowUp, Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Resolution } from "./api";

type Props = {
  instruction: string;
  resolution: Resolution | null;
  disabled: boolean;
  resolving: boolean;
  onInstructionChange: (instruction: string) => void;
  onResolve: () => void;
};

export default function ChatPanel({
  instruction,
  resolution,
  disabled,
  resolving,
  onInstructionChange,
  onResolve,
}: Props) {
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState("");
  const target = resolution?.result.target;
  const tooLong = instruction.trim().length > 4000;

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
      className="flex h-[38%] min-h-[180px] min-w-0 flex-col border-t border-border bg-muted/40 sm:h-auto sm:min-h-0 sm:border-t-0 sm:border-r"
      aria-label="Chat"
    >
      <div className="flex min-h-11 items-center px-3 py-1.5 sm:min-h-[53px] sm:py-2.5 md:px-4">
        <h1 className="text-sm font-medium text-muted-foreground">Chat</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 md:px-4" aria-live="polite">
        {resolution && (
          <div className="space-y-3 pb-3 text-sm">
            <p className="rounded-lg bg-accent px-3 py-2 break-words">{resolution.instruction}</p>
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
                  <h2 className="font-medium break-words">{target.label || target.tag}</h2>
                  <p className="text-muted-foreground">
                    {resolution.result.action} · {target.tag}
                  </p>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
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
                <ol className="space-y-2" aria-label="Verified XPath alternatives">
                  {target.xpaths.map((xpath, index) => (
                    <li
                      key={xpath}
                      className="flex items-start gap-1 rounded-md border bg-background p-2"
                    >
                      <code className="min-w-0 flex-1 text-xs break-all">{xpath}</code>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-6"
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
        {tooLong && (
          <p id="instruction-error" role="alert" className="text-sm text-destructive">
            Use 4,000 characters or fewer.
          </p>
        )}
        {resolving && (
          <p role="status" className="text-sm text-muted-foreground">
            Resolving…
          </p>
        )}
      </div>
      <form
        className="mx-3 my-2 flex items-end gap-2 rounded-lg border border-input bg-background p-2 sm:my-3 sm:p-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled && !tooLong && instruction.trim()) {
            setCopied("");
            setCopyError("");
            onResolve();
          }
        }}
      >
        <textarea
          className="h-7 w-full min-w-0 resize-none border-0 bg-transparent p-0.5 leading-normal placeholder:text-muted-foreground placeholder:opacity-100 sm:h-auto"
          aria-label="Describe an element"
          aria-invalid={tooLong}
          aria-describedby={tooLong ? "instruction-error" : undefined}
          placeholder="Describe an element…"
          rows={2}
          value={instruction}
          onChange={(event) => onInstructionChange(event.currentTarget.value)}
          disabled={disabled}
        />
        <Button
          type="submit"
          size="icon"
          className="size-7"
          aria-label="Resolve instruction"
          disabled={disabled || tooLong || !instruction.trim()}
        >
          <ArrowUp aria-hidden="true" />
        </Button>
      </form>
    </aside>
  );
}
