import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ResolutionResult } from "./api";

function usd(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0) return "Unavailable";
  if (value > 0 && value < 0.00000001) return "< $0.00000001";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`;
}

export default function ResolutionCost({
  diagnostics,
}: {
  diagnostics: ResolutionResult["diagnostics"];
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const anchor = `--cost-${id.replace(/[^a-z0-9_-]/gi, "")}`;
  const tooltip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (open) tooltip.current?.showPopover?.();
  }, [open]);
  const { usage, costEstimate: estimate } = diagnostics;
  const rows = [
    ["Model", diagnostics.model ?? "Unavailable"],
    ["Provider", diagnostics.provider ?? "Unavailable"],
    ["Input tokens", usage?.inputTokens?.toLocaleString() ?? "Unavailable"],
    ["Output tokens", usage?.outputTokens?.toLocaleString() ?? "Unavailable"],
    [
      "Reasoning tokens (included in output)",
      usage?.reasoningTokens?.toLocaleString() ?? "Unavailable",
    ],
    ["Cached input tokens", usage?.cachedTokens?.toLocaleString() ?? "Unavailable"],
    ["Input / 1M tokens", usd(estimate?.inputPricePerMillion)],
    ["Output / 1M tokens", usd(estimate?.outputPricePerMillion)],
    ["Estimated input", usd(estimate?.inputCost)],
    ["Estimated output", usd(estimate?.outputCost)],
    ["Per-request fee", usd(estimate?.requestCost)],
    ["Estimated total", usd(estimate?.totalCost)],
    ["Reported cost", usd(usage?.cost)],
  ];

  return (
    <div
      className="relative w-fit text-xs text-muted-foreground"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        className="cursor-help rounded-sm underline decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-describedby={open ? id : undefined}
        style={{ anchorName: anchor }}
      >
        {estimate
          ? `Estimated cost: ${usd(estimate.totalCost)}`
          : usage?.cost != null
            ? `Reported cost: ${usd(usage.cost)}`
            : diagnostics.providerAccounting === "pending"
              ? "Cost pending"
              : "Cost unavailable"}
      </button>
      {open && (
        <div
          ref={tooltip}
          id={id}
          role="tooltip"
          popover="manual"
          className="fixed inset-auto m-0 w-72 max-w-[calc(100vw-2rem)] border-0 bg-transparent pt-2"
          style={{
            positionAnchor: anchor,
            positionArea: "bottom span-right",
            positionTryFallbacks: "flip-block, flip-inline",
            justifySelf: "start",
          }}
        >
          <div className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md">
            <p className="mb-2 font-medium">Cost breakdown · USD</p>
            {diagnostics.providerAccounting === "pending" && (
              <p className="mb-2">The provider may still charge this timed-out request.</p>
            )}
            <dl className="space-y-1.5">
              {rows.map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt>{label}</dt>
                  <dd className="min-w-0 text-right break-words tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-muted-foreground">
              Estimate uses listed rates before cache discounts. Reported cost is OpenRouter’s
              charge.
            </p>
            {estimate && (
              <p className="mt-1 text-muted-foreground">
                Rates fetched {new Date(estimate.pricingFetchedAt).toLocaleString()}.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
