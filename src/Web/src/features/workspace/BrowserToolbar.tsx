import { useEffect, useRef } from "react";
import type { FormEvent } from "react";
import { ArrowRight, ChevronDown, LoaderCircle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import type { BrowserResolution } from "./api";

type Props = {
  resolution: string;
  resolutions: BrowserResolution[];
  onResolutionChange: (resolution: string) => void;
  canStart: boolean;
  sessionId: string | undefined;
  pageUrl: string | undefined;
  address: string;
  focusRequest?: number;
  busy: boolean;
  onAddressChange: (address: string) => void;
  onNavigate: (url: string) => void;
};

export default function BrowserToolbar({
  resolution,
  resolutions,
  onResolutionChange,
  canStart,
  sessionId,
  pageUrl,
  address,
  focusRequest = 0,
  busy,
  onAddressChange,
  onNavigate,
}: Props) {
  const addressInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    addressInput.current?.focus();
  }, [sessionId, focusRequest]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const url = address.trim();
    if (url && !busy && canStart)
      onNavigate(/^[a-z][a-z\d+.-]*:/i.test(url) ? url : `https://${url}`);
  }
  const hasPage = /^https?:\/\//i.test(pageUrl ?? "");
  return (
    <form
      className="flex min-h-14 items-center gap-2 border-b border-border px-3 py-2"
      onSubmit={submit}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="gap-1 px-2"
            aria-label={`Browser resolution: ${resolution}`}
            title={sessionId ? "Close all tabs to change resolution" : "Browser resolution"}
            disabled={!!sessionId || busy || resolutions.length === 0}
          >
            {resolution.replace("x", " × ")}
            <ChevronDown className="size-3" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup value={resolution} onValueChange={onResolutionChange}>
            {resolutions.map((choice) => (
              <DropdownMenuRadioItem key={choice.id} value={choice.id}>
                {choice.width} × {choice.height}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
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
        className="h-9 flex-1 rounded-lg bg-muted/60 px-3"
        aria-label="Page address"
        placeholder="Enter a website address"
        value={address}
        onChange={(event) => onAddressChange(event.currentTarget.value)}
        disabled={busy}
        spellCheck={false}
        autoComplete="off"
      />
      <Button
        type="submit"
        variant="ghost"
        size="icon"
        title="Go to address"
        aria-label="Go to address"
        disabled={!address.trim() || busy || !canStart}
      >
        {busy ? (
          <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />
        ) : (
          <ArrowRight aria-hidden="true" />
        )}
      </Button>
    </form>
  );
}
