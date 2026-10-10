import { ArrowUp, Eraser } from "lucide-react";
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
import type { ImageMode, Resolution } from "./api";
import ResolutionMessage from "./ResolutionMessage";
import WorkspaceSettings from "./WorkspaceSettings";

type Props = {
  instruction: string;
  imageMode: ImageMode;
  onImageModeChange: (imageMode: ImageMode) => void;
  autoExecute: boolean;
  onAutoExecuteChange: (enabled: boolean) => void;
  settingsDisabled: boolean;
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
  autoExecute,
  onAutoExecuteChange,
  settingsDisabled,
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
        <div className="ml-auto flex items-center gap-2">
          {autoExecute && <span className="text-xs text-muted-foreground">Auto execute on</span>}
          <WorkspaceSettings
            imageMode={imageMode}
            onImageModeChange={onImageModeChange}
            autoExecute={autoExecute}
            onAutoExecuteChange={onAutoExecuteChange}
            disabled={settingsDisabled}
          />
        </div>
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
        {history.map((resolution) => (
          <ResolutionMessage
            key={resolution.id}
            resolution={resolution}
            disabled={disabled}
            resolving={resolving}
            copied={copied}
            copyError={copyError}
            onCopy={copy}
            onSpotlight={onSpotlight}
            onExecute={onExecute}
            onRetry={(instruction) => {
              followBottom.current = true;
              setCopied("");
              setCopyError(null);
              onResolve(instruction);
            }}
          />
        ))}
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
