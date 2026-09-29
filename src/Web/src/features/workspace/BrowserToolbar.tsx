import { useEffect, useRef } from "react";
import type { FormEvent } from "react";
import Icon from "../../components/Icon";

type Props = {
  sessionId: string | undefined;
  pageUrl: string | undefined;
  address: string;
  busy: boolean;
  onAddressChange: (address: string) => void;
  onNavigate: (url: string) => void;
};

export default function BrowserToolbar({
  sessionId,
  pageUrl,
  address,
  busy,
  onAddressChange,
  onNavigate,
}: Props) {
  const addressInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (sessionId) addressInput.current?.focus();
  }, [sessionId]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const url = address.trim();
    if (url) onNavigate(/^[a-z][a-z\d+.-]*:/i.test(url) ? url : `https://${url}`);
  }
  const hasPage = /^https?:\/\//i.test(pageUrl ?? "");
  return (
    <form
      className="flex min-h-[53px] items-center gap-[5px] border-b border-[#e8e5eb] px-3 py-2"
      onSubmit={submit}
    >
      <button
        type="button"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-[5px] border-0 bg-transparent text-muted enabled:hover:bg-soft"
        title="Reload page"
        aria-label="Reload page"
        onClick={() => pageUrl && onNavigate(pageUrl)}
        disabled={!hasPage || busy}
      >
        <Icon name="refresh" size={17} />
      </button>
      <input
        ref={addressInput}
        className="h-[33px] min-w-0 flex-1 rounded-[5px] border border-[#e7e4eb] bg-[#f8f7fa] px-2.5 text-sm placeholder:text-muted placeholder:opacity-100"
        aria-label="Page address"
        placeholder="Enter a website address"
        value={address}
        onChange={(event) => onAddressChange(event.currentTarget.value)}
        disabled={!sessionId || busy}
        spellCheck={false}
        autoComplete="off"
      />
      <button
        type="submit"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-[5px] border-0 bg-transparent text-muted enabled:hover:bg-soft"
        aria-label="Go to address"
        disabled={!sessionId || !address.trim() || busy}
      >
        <Icon name="arrow" size={17} />
      </button>
    </form>
  );
}
