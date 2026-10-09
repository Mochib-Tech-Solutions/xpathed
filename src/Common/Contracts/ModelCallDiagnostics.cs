namespace Xpathed.Common.Contracts;

public sealed record ModelCallDiagnostics(
    string Purpose,
    string? Model,
    string? Provider,
    string? GenerationId,
    ModelUsage? Usage,
    ModelCostEstimate? CostEstimate,
    string Accounting,
    string? Code,
    double DurationMs
);
