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

function ModelCostRow({ model, calls }: { model: string; calls: ProviderCall[] }) {
  const reported = total(calls, (call) => call.usage?.cost);
  const estimated = total(calls, (call) => call.costEstimate?.totalCost);
  const tokens = total(calls, (call) => call.usage?.totalTokens);
  const pending = calls.some((call) => call.accounting === "pending");
  return (
    <tr className="border-t border-border align-top">
      <th scope="row" className="w-full max-w-0 py-2 pr-3 text-left font-normal break-words">
        {model}
      </th>
      <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
        {reported != null ? (
          usd(reported)
        ) : estimated != null ? (
          <>
            {usd(estimated)} <span className="block text-muted-foreground">Estimated</span>
          </>
        ) : pending ? (
          "Pending"
        ) : (
          "Unavailable"
        )}
      </td>
      <td className="py-2 text-right whitespace-nowrap tabular-nums">
        {tokens?.toLocaleString("en-US") ?? "Unavailable"}
      </td>
    </tr>
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
  const models = new Map<string, ProviderCall[]>();
  for (const call of calls) {
    const model = call.model ?? "Unavailable";
    const group = models.get(model);
    if (group) group.push(call);
    else models.set(model, [call]);
  }
  const reported = total(calls, (call) => call.usage?.cost);
  const estimated = total(calls, (call) => call.costEstimate?.totalCost);
  const pending = calls.some((call) => call.accounting === "pending");
  const label =
    calls.length === 0
      ? "No model calls"
      : reported != null
        ? `Reported cost: ${usd(reported)}`
        : estimated != null
          ? `Estimated cost: ${usd(estimated)}`
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
          className="fixed inset-auto m-0 w-80 max-w-[calc(100vw-2rem)] border-0 bg-transparent pt-2"
          style={{
            positionAnchor: anchor,
            positionArea: "bottom span-right",
            positionTryFallbacks: "flip-block, flip-inline",
            justifySelf: "start",
          }}
        >
          <div className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md">
            {calls.length === 0 ? (
              <p>No model calls</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th scope="col" className="pb-2 text-left font-medium">
                      Model
                    </th>
                    <th scope="col" className="pr-3 pb-2 text-right font-medium whitespace-nowrap">
                      Cost (USD)
                    </th>
                    <th scope="col" className="pb-2 text-right font-medium">
                      Tokens
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from(models, ([model, calls]) => (
                    <ModelCostRow key={model} model={model} calls={calls} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
