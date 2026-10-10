import { useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { SelectState } from "./viewerProtocol";

export default function BrowserSelectPicker({
  picker,
  onClose,
}: {
  picker: SelectState | null;
  onClose: () => void;
}) {
  const optionInput = useRef<HTMLSelectElement>(null);
  return (
    <AlertDialog open={picker !== null}>
      {picker && (
        <AlertDialogContent
          key={picker.pickerId}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            picker.answer(null);
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            optionInput.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onClose();
          }}
        >
          <AlertDialogTitle>Choose an option</AlertDialogTitle>
          <AlertDialogDescription>
            Choose an option for the page, then apply it.
          </AlertDialogDescription>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (optionInput.current?.value) picker.answer(optionInput.current.value);
            }}
          >
            <label className="block space-y-1 text-sm">
              <span>Option</span>
              <select
                ref={optionInput}
                aria-label="Option"
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                defaultValue={picker.options.find((option) => option.selected)?.id ?? ""}
                disabled={picker.pending}
                required
              >
                <option value="" disabled>
                  Choose an option
                </option>
                {picker.options.map((option) => (
                  <option key={option.id} value={option.id} disabled={option.disabled}>
                    {option.label || "(Unnamed option)"}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={picker.pending}
                onClick={() => picker.answer(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={picker.pending || !picker.options.some((option) => !option.disabled)}
              >
                Apply
              </Button>
            </div>
          </form>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
