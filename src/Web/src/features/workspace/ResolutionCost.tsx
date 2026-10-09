import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ProviderCall, ResolutionResult } from "./api";

function validCost(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

function usd(value: number | null | undefined) {
  if (!validCost(value)) return "Unavailable";
  if (value > 0 && value < 0.00000001) return "< $0.00000001";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`;
}

function total(calls: ProviderCall[], amount: (call: ProviderCall) => number | null | undefined) {
  const values = calls.map(amount);
  return values.every(validCost) ? values.reduce((sum, value) => sum + value, 0) : null;
}

function CostRows({ call }: { call: ProviderCall }) {
  const { usage, costEstimate: estimate } = call;
  const rows = [
    ["Model", call.model ?? "Unavailable"],
    ["Provider", call.provider ?? "Unavailable"],
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
    <>
      <dl className="space-y-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt>{label}</dt>
            <dd className="min-w-0 text-right break-words tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {estimate && (
        <p className="mt-1 text-muted-foreground">
          Rates fetched {new Date(estimate.pricingFetchedAt).toLocaleString()}.
        </p>
      )}
    </>
  );
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
  const detailed = diagnostics.providerCalls != null;
  const calls: ProviderCall[] = diagnostics.providerCalls ?? [
    {
      purpose: "selection",
      model: diagnostics.model,
      provider: diagnostics.provider,
      usage: diagnostics.usage,
      costEstimate: diagnostics.costEstimate,
      accounting: diagnostics.providerAccounting,
    },
  ];
  const reported = total(calls, (call) => call.usage?.cost);
  const estimated = total(calls, (call) => call.costEstimate?.totalCost);
  const pending = calls.some((call) => call.accounting === "pending");
  const label =
    calls.length === 0
      ? "No model calls"
      : detailed && reported != null
        ? `Reported cost: ${usd(reported)}`
        : estimated != null
          ? `Estimated cost: ${usd(estimated)}`
          : reported != null
            ? `Reported cost: ${usd(reported)}`
            : pending
              ? "Cost pending"
              : "Cost unavailable";

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
        {label}
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
            {pending && (
              <p className="mb-2">
                {detailed
                  ? "A provider call is still being accounted for. Its charge may arrive later."
                  : "The provider may still charge this timed-out request."}
              </p>
            )}
            {detailed && calls.length > 0 && (
              <dl className="mb-3 space-y-1.5 border-b border-border pb-3">
                <div className="flex justify-between gap-3">
                  <dt>Reported request total</dt>
                  <dd>{usd(reported)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>Estimated request total</dt>
                  <dd>{usd(estimated)}</dd>
                </div>
              </dl>
            )}
            {detailed && reported == null && (
              <p className="mb-3">
                Some calls have no reported charge. Known charges below are not a complete total.
              </p>
            )}
            {calls.map((call, index) => (
              <section
                key={index}
                className={index > 0 ? "mt-3 border-t border-border pt-3" : undefined}
                aria-label={
                  call.purpose === "image_routing"
                    ? "Image decision cost"
                    : "Element selection cost"
                }
              >
                {detailed && (
                  <p className="mb-2 font-medium">
                    {call.purpose === "image_routing" ? "Image decision" : "Element selection"}
                    {call.accounting === "pending" ? " · Pending" : ""}
                  </p>
                )}
                <CostRows call={call} />
              </section>
            ))}
            {calls.length === 0 ? (
              <p>No provider calls were made for this request.</p>
            ) : (
              <p className="mt-3 text-muted-foreground">
                Estimates use listed rates before cache discounts. Reported costs are provider
                charges.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
