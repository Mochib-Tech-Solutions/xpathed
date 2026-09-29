import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ChatPanel() {
  return (
    <aside
      className="flex h-[38%] min-h-[180px] flex-col border-t border-border bg-muted/40 sm:h-auto sm:min-h-0 sm:border-t-0 sm:border-r"
      aria-label="Chat"
    >
      <div className="flex min-h-11 items-center px-3 py-1.5 sm:min-h-[53px] sm:py-2.5 md:px-4">
        <h1 className="text-sm font-medium text-muted-foreground">Chat</h1>
      </div>
      <div className="min-h-0 flex-1" />
      <div
        className="mx-3 my-2 flex items-end gap-2 rounded-lg border border-input bg-background p-2 sm:my-3 sm:p-2.5"
        title="Command resolution is not available yet."
      >
        <textarea
          className="h-7 w-full min-w-0 resize-none border-0 bg-transparent p-0.5 leading-normal placeholder:text-muted-foreground placeholder:opacity-100 sm:h-auto"
          aria-label="Describe an element"
          placeholder="Describe an element…"
          rows={2}
          disabled
        />
        <Button type="button" size="icon" className="size-7" aria-label="Send command" disabled>
          <ArrowUp aria-hidden="true" />
        </Button>
      </div>
    </aside>
  );
}
