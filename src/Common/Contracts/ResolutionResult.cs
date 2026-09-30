namespace Xpathed.Common.Contracts;

public sealed record ResolutionResult(
    string ContractVersion,
    string Outcome,
    string? SessionId,
    string PageId,
    string DocumentId,
    string? CaptureId,
    string? FrameId,
    string TraceId,
    string AttemptId,
    string ConfigurationId,
    string? Action,
    ResolvedTarget? Target,
    ResolutionDiagnostics Diagnostics,
    ActionResolution[]? Actions = null,
    ResolutionSummary? Summary = null,
    string? InspectedActionId = null
);
