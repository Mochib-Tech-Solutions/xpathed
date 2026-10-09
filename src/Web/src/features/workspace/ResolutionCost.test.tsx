import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ModelCostEstimate, ModelUsage, ProviderCall } from "./api";
import ResolutionCost from "./ResolutionCost";

const usage = (cost: number | null): ModelUsage => ({
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  reasoningTokens: 0,
  cachedTokens: 0,
  cost,
});
const estimate = (totalCost: number): ModelCostEstimate => ({
  currency: "USD",
  inputPricePerMillion: 1,
  outputPricePerMillion: 2,
  inputCost: totalCost / 2,
  outputCost: totalCost / 2,
  requestCost: 0,
  totalCost,
  pricingFetchedAt: "2026-10-09T10:00:00Z",
});
const call = (purpose: ProviderCall["purpose"], cost: number | null): ProviderCall => ({
  purpose,
  model: purpose === "image_routing" ? "Jev" : "DeepSeek",
  provider: purpose === "image_routing" ? "TypeSafe" : "Wafer",
  usage: usage(cost),
  accounting: cost === null ? "unavailable" : "completed",
});
const show = (calls: ProviderCall[]) =>
  render(
    <ResolutionCost
      diagnostics={{
        code: null,
        message: null,
        providerCalls: calls,
        // Scalars describe selection only and must not be added to the call list.
        usage: usage(0.99),
        costEstimate: estimate(0.88),
      }}
    />,
  );
const details = (name: string) => {
  fireEvent.focus(screen.getByRole("button", { name }));
  return screen.getByRole("tooltip");
};

describe("Request cost accounting", () => {
  it("totals both actual charges once and retains each provider's breakdown", () => {
    show([call("image_routing", 0.01), call("selection", 0.02)]);
    const tooltip = details("Reported cost: $0.03");
    expect(within(tooltip).getByText("$0.03")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Image decision cost" })).getByText("$0.01"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Element selection cost" })).getByText("$0.02"),
    ).toBeInTheDocument();
    expect(within(tooltip).queryByText("$0.99")).not.toBeInTheDocument();
  });

  it("does not present a known selection charge as the total when routing cost is unknown", () => {
    show([call("image_routing", null), call("selection", 0.02)]);
    const tooltip = details("Cost unavailable");
    expect(tooltip).toHaveTextContent("Known charges below are not a complete total.");
    expect(
      within(screen.getByRole("region", { name: "Element selection cost" })).getByText("$0.02"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reported cost/ })).not.toBeInTheDocument();
  });

  it("keeps a pending router charge pending after final selection completes", () => {
    show([{ ...call("image_routing", null), accounting: "pending" }, call("selection", 0)]);
    const tooltip = details("Cost pending");
    expect(tooltip).toHaveTextContent("Its charge may arrive later.");
    expect(screen.getByRole("region", { name: "Image decision cost" })).toHaveTextContent(
      "Pending",
    );
  });

  it("keeps estimates separate and totals them only when every call has one", () => {
    show([
      { ...call("image_routing", null), costEstimate: estimate(0.01) },
      { ...call("selection", null), costEstimate: estimate(0.02) },
    ]);
    const tooltip = details("Estimated cost: $0.03");
    expect(within(tooltip).getByText("$0.03")).toBeInTheDocument();
    expect(tooltip).toHaveTextContent("Reported request totalUnavailable");
    expect(screen.queryByRole("button", { name: /Reported cost/ })).not.toBeInTheDocument();
  });

  it("retains a router-only charge when no selection call was made", () => {
    show([call("image_routing", 0.01)]);
    details("Reported cost: $0.01");
    expect(
      screen.queryByRole("region", { name: "Element selection cost" }),
    ).not.toBeInTheDocument();
  });

  it("counts a zero charge and does not invent calls when routing was cached", () => {
    show([call("selection", 0)]);
    details("Reported cost: $0.00");
    expect(screen.queryByRole("region", { name: "Image decision cost" })).not.toBeInTheDocument();
  });

  it("ignores scalar charges when the server reports no provider calls", () => {
    show([]);
    const tooltip = details("No model calls");
    expect(tooltip).toHaveTextContent("No provider calls were made");
    expect(within(tooltip).queryByText("$0.99")).not.toBeInTheDocument();
  });
});
