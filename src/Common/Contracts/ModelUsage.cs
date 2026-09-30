namespace Xpathed.Common.Contracts;

public sealed record ModelUsage(
    long? InputTokens,
    long? OutputTokens,
    long? TotalTokens,
    long? ReasoningTokens,
    long? CachedTokens,
    decimal? Cost
);
