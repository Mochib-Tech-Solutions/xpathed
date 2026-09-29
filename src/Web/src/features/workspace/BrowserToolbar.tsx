import { useEffect, useRef } from "react";
import type { FormEvent } from "react";
import { ArrowRight, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
      className="flex min-h-[53px] items-center gap-1.5 border-b border-border px-3 py-2"
      onSubmit={submit}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title="Reload page"
        aria-label="Reload page"
        onClick={() => pageUrl && onNavigate(pageUrl)}
        disabled={!hasPage || busy}
      >
        <RotateCw aria-hidden="true" />
      </Button>
      <Input
        ref={addressInput}
        className="flex-1 bg-muted/60"
        aria-label="Page address"
        placeholder="Enter a website address"
        value={address}
        onChange={(event) => onAddressChange(event.currentTarget.value)}
        disabled={!sessionId || busy}
        spellCheck={false}
        autoComplete="off"
      />
      <Button
        type="submit"
        variant="ghost"
        size="icon"
        aria-label="Go to address"
        disabled={!sessionId || !address.trim() || busy}
      >
        <ArrowRight aria-hidden="true" />
      </Button>
    </form>
  );
}
