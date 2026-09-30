import { Plus, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { PageState } from "./api";
import CloseAllTabsButton from "./CloseAllTabsButton";

type Props = {
  pages: PageState[];
  activePageId?: string;
  busy: boolean;
  onNew: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseAll: () => void;
};
export default function BrowserTabs({
  pages,
  activePageId,
  busy,
  onNew,
  onSelect,
  onClose,
  onCloseAll,
}: Props) {
  const strip = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (busy || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (document.activeElement === document.body || strip.current?.contains(document.activeElement))
      document.getElementById(`tab-${activePageId}`)?.focus();
  }, [activePageId, busy]);
  return (
    <div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border bg-muted/40 px-2">
      <div
        ref={strip}
        role="tablist"
        aria-label="Browser tabs"
        className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
      >
        {pages.map((page, index) => {
          const title = page.title || (page.url === "about:blank" ? "New tab" : page.url);
          return (
            <div
              role="presentation"
              key={page.pageId}
              className="flex max-w-56 min-w-24 shrink-0 items-center rounded-t-md border border-b-0 border-transparent has-[[aria-selected=true]]:border-border has-[[aria-selected=true]]:bg-background"
            >
              <button
                type="button"
                role="tab"
                id={`tab-${page.pageId}`}
                aria-controls="browser-panel"
                aria-selected={page.pageId === activePageId}
                tabIndex={page.pageId === activePageId ? 0 : -1}
                title={page.url}
                disabled={busy}
                className="min-w-0 flex-1 truncate rounded-sm px-3 py-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                onClick={() => onSelect(page.pageId)}
                onKeyDown={(event) => {
                  if (event.key === "Delete") {
                    event.preventDefault();
                    restoreFocus.current = true;
                    onClose(page.pageId);
                    return;
                  }
                  const target =
                    event.key === "ArrowRight"
                      ? (index + 1) % pages.length
                      : event.key === "ArrowLeft"
                        ? (index + pages.length - 1) % pages.length
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? pages.length - 1
                            : -1;
                  if (target < 0) return;
                  event.preventDefault();
                  const next = pages[target]!;
                  document.getElementById(`tab-${next.pageId}`)?.focus();
                  restoreFocus.current = next.pageId !== activePageId;
                  onSelect(next.pageId);
                }}
              >
                {title}
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="mr-1 size-6"
                disabled={busy}
                title={`Close ${title} tab and clear its chat`}
                aria-label={`Close ${title} tab and clear its chat`}
                onClick={() => {
                  restoreFocus.current = strip.current?.contains(document.activeElement) ?? false;
                  onClose(page.pageId);
                }}
              >
                <X className="size-3" aria-hidden="true" />
              </Button>
            </div>
          );
        })}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        disabled={busy}
        aria-label="New tab"
        title="New tab"
        onClick={onNew}
      >
        <Plus aria-hidden="true" />
      </Button>
      <CloseAllTabsButton disabled={busy} onConfirm={onCloseAll} />
    </div>
  );
}
