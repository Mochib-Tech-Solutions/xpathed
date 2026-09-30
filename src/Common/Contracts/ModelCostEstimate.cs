namespace Xpathed.Common.Contracts;

public sealed record ModelCostEstimate(decimal InputPricePerMillion, decimal OutputPricePerMillion, decimal InputCost, decimal OutputCost, decimal RequestCost, decimal TotalCost, DateTimeOffset PricingFetchedAt)
{
    public string Currency { get; init; } = "USD";
}
