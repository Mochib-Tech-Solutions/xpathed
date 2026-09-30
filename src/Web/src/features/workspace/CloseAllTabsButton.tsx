import { X } from "lucide-react";
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

type Props = { disabled: boolean; onConfirm: () => void };

export default function CloseAllTabsButton({ disabled, onConfirm }: Props) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={disabled}
          aria-label="Close all tabs"
          title="Close all tabs"
        >
          <X className="size-3.5" aria-hidden="true" />
          Close all
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>Close all tabs?</AlertDialogTitle>
        <AlertDialogDescription>
          All tabs, chat history and browsing state will be cleared.
        </AlertDialogDescription>
        <div className="mt-3 flex justify-end gap-2">
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={disabled} onClick={onConfirm}>
            Close all tabs
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
