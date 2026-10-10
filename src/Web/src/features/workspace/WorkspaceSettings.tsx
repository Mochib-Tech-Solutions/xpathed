import { Settings } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ImageMode } from "./api";

export default function WorkspaceSettings({
  imageMode,
  onImageModeChange,
  autoExecute,
  onAutoExecuteChange,
  disabled,
}: {
  imageMode: ImageMode;
  onImageModeChange: (mode: ImageMode) => void;
  autoExecute: boolean;
  onAutoExecuteChange: (enabled: boolean) => void;
  disabled: boolean;
}) {
  const imageHelp = useId();
  const executionHelp = useId();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Settings"
          title="Settings"
        >
          <Settings aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <div className="space-y-1">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Each tab keeps its own settings.</DialogDescription>
        </div>
        <div className="space-y-2">
          <label className="flex items-center justify-between gap-3 text-sm font-medium">
            Screenshots
            <select
              value={imageMode}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === "auto" || value === "text_only") onImageModeChange(value);
              }}
              disabled={disabled}
              aria-describedby={imageHelp}
              className="rounded-md border border-input bg-background px-2 py-1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="auto">Auto</option>
              <option value="text_only">Text only</option>
            </select>
          </label>
          <p id={imageHelp} className="text-xs leading-relaxed text-muted-foreground">
            {imageMode === "auto"
              ? "Auto sends a masked screenshot to the model provider when visual details may help. Other visible content can be shared."
              : "Text only sends page text and structure, without screenshots."}
          </p>
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={autoExecute}
              onChange={(event) => onAutoExecuteChange(event.currentTarget.checked)}
              disabled={disabled}
              aria-describedby={executionHelp}
              className="size-4 rounded border-input accent-primary focus-visible:outline-2 focus-visible:outline-ring"
            />
            Execute automatically
          </label>
          <p id={executionHelp} className="text-xs leading-relaxed text-muted-foreground">
            Execute a single ready action after resolving. Actions that need a value and results
            with multiple targets stay manual.
          </p>
        </div>
        <div className="flex justify-end">
          <DialogClose asChild>
            <Button>Done</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
