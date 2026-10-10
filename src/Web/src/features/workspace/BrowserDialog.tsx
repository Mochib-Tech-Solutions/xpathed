import { useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import type { DialogState } from "./viewerProtocol";

export default function BrowserDialog({
  dialog,
  onClose,
}: {
  dialog: DialogState | null;
  onClose: () => void;
}) {
  const promptInput = useRef<HTMLInputElement>(null);
  const cancelDialog = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={dialog !== null}>
      {dialog && (
        <AlertDialogContent
          key={dialog.dialogId}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            dialog.answer(false);
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (dialog.dialogType === "prompt" ? promptInput.current : cancelDialog.current)?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onClose();
          }}
        >
          <AlertDialogTitle>
            {dialog.dialogType === "beforeunload"
              ? "Leave this page?"
              : dialog.dialogType === "prompt"
                ? "Page prompt"
                : dialog.dialogType === "alert"
                  ? "Page alert"
                  : "Page confirmation"}
          </AlertDialogTitle>
          <AlertDialogDescription className="max-h-64 overflow-y-auto break-words whitespace-pre-wrap">
            {dialog.message || "The page is waiting for your response."}
          </AlertDialogDescription>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              dialog.answer(
                true,
                dialog.dialogType === "prompt" ? (promptInput.current?.value ?? "") : undefined,
              );
            }}
          >
            {dialog.dialogType === "prompt" && (
              <Input
                ref={promptInput}
                aria-label="Response"
                defaultValue={dialog.defaultPrompt}
                disabled={dialog.pending}
              />
            )}
            <div className="mt-3 flex justify-end gap-2">
              {dialog.dialogType !== "alert" && (
                <Button
                  ref={cancelDialog}
                  type="button"
                  variant="outline"
                  disabled={dialog.pending}
                  onClick={() => dialog.answer(false)}
                >
                  {dialog.dialogType === "beforeunload" ? "Stay" : "Cancel"}
                </Button>
              )}
              <Button
                ref={dialog.dialogType === "alert" ? cancelDialog : undefined}
                type="submit"
                disabled={dialog.pending}
              >
                {dialog.dialogType === "beforeunload" ? "Leave page" : "OK"}
              </Button>
            </div>
          </form>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
