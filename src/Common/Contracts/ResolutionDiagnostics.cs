namespace Xpathed.Common.Contracts;

public sealed record ResolutionDiagnostics
{
    public string? Code { get; init; }
    public string? Message { get; init; }
    public string Stage { get; init; } = "capture";
    public CaptureCoverage? Capture { get; init; }
    public int ModelInputCount { get; init; }
    public bool ModelInputComplete { get; init; }
    public int ModelInputBytes { get; init; }
    public int ModelInputBudgetBytes { get; init; } = 512000;
    public int ModelCalls { get; init; }
    public SelectionRule? SelectionRule { get; init; }
    public string Strategy { get; init; } = "candidate-selection";
    public string? Model { get; init; }
    public string? Provider { get; init; }
    public string? GenerationId { get; init; }
    public string? FinishReason { get; init; }
    public ModelUsage? Usage { get; init; }
    public ModelCostEstimate? CostEstimate { get; init; }
    public string? ProviderAccounting { get; init; }
    public Dictionary<string, double> TimingsMs { get; init; } = [];
}
