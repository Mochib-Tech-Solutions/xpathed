import { useState } from "react";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResolution, Resolution } from "./api";
import { canExecute, needsExecutionValue } from "./actionExecution";

const keys = [
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
  "Space",
];

export default function ExecuteAction({
  entry,
  action,
  disabled,
  onExecute,
}: {
  entry: Resolution;
  action: ActionResolution;
  disabled: boolean;
  onExecute: (entry: Resolution, actionId: string, value?: string) => void;
}) {
  const [value, setValue] = useState("");
  const execution = entry.execution?.actionId === action.actionId ? entry.execution : null;
  if (execution)
    return (
      <p
        role={
          execution.status === "failed" || execution.status === "uncertain" ? "alert" : "status"
        }
        className={
          execution.status === "failed" || execution.status === "uncertain"
            ? "text-destructive"
            : "text-muted-foreground"
        }
      >
        {execution.message}
      </p>
    );
  if (!canExecute(entry, action)) return null;
  const needsValue = needsExecutionValue(action.action);
  const label = action.action === "select" ? "Option value" : "Value to enter";
  return (
    <form
      className="space-y-2 border-t border-border/70 pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          disabled ||
          (action.action === "press" && !value) ||
          (action.action === "type" && !value)
        )
          return;
        onExecute(entry, action.actionId, needsValue ? value : undefined);
        setValue("");
      }}
    >
      {action.action === "press" ? (
        <label className="block space-y-1 text-xs">
          <span>Key to press</span>
          <select
            aria-label={`Key to press for target ${action.order}`}
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
            disabled={disabled}
            required
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">Choose a key</option>
            {keys.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
      ) : (
        needsValue && (
          <label className="block space-y-1 text-xs">
            <span>{label}</span>
            <Input
              aria-label={`${label} for target ${action.order}`}
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
              disabled={disabled}
              maxLength={10000}
              autoComplete="off"
            />
            <span className="text-muted-foreground">This value goes directly to the browser.</span>
          </label>
        )
      )}
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={disabled || (["press", "type"].includes(action.action) && !value)}
        aria-label={`Execute ${action.action.replaceAll("_", "-")} on target ${action.order}`}
      >
        <Play aria-hidden="true" /> Execute {action.action.replaceAll("_", "-")}
      </Button>
    </form>
  );
}
