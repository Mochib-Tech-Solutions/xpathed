import { useId, useRef } from "react";
import Icon from "../../components/Icon";

type Props = { disabled: boolean; onConfirm: () => void };

export default function ResetSessionButton({ disabled, onConfirm }: Props) {
  const resetDialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  return (
    <>
      <button
        type="button"
        className="inline-flex items-center justify-center gap-2 rounded-md border border-[#dfdbe4] bg-white px-[11px] py-2 text-sm whitespace-nowrap enabled:hover:bg-soft"
        onClick={() => resetDialog.current?.showModal()}
        disabled={disabled}
      >
        <Icon name="refresh" size={15} />
        Reset session
      </button>
      <dialog
        ref={resetDialog}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="m-auto w-[400px] max-w-[calc(100vw-32px)] rounded-xl border border-line bg-white p-6 text-ink shadow-lg backdrop:bg-ink/30"
      >
        <h2 id={titleId} className="font-semibold">
          Reset session?
        </h2>
        <p id={descriptionId} className="mt-3 leading-relaxed text-muted">
          Your page, chat and browsing state will be cleared.
        </p>
        <form method="dialog" className="mt-6 flex justify-end gap-2">
          <button
            type="submit"
            autoFocus
            className="rounded-md border border-[#dfdbe4] bg-white px-3 py-2 text-sm enabled:hover:bg-soft"
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md border border-accent bg-accent px-3 py-2 text-sm text-white enabled:hover:bg-accent-hover"
            disabled={disabled}
            onClick={() => {
              resetDialog.current?.close();
              onConfirm();
            }}
          >
            Reset session
          </button>
        </form>
      </dialog>
    </>
  );
}
