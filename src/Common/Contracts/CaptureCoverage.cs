namespace Xpathed.Common.Contracts;

public sealed record CaptureCoverage(
    int ScannedCount,
    int EligibleCount,
    int CapturedCount,
    bool Complete,
    string? ErrorCode
);
