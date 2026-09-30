namespace Xpathed.Common.Contracts;

public sealed record ResolutionSummary(
    bool ProcessingComplete,
    string SemanticCompleteness,
    int Total,
    int Found,
    int NotFound,
    int Unsupported,
    int Errors,
    int Blocked,
    int ReadinessUnknown,
    int AssessmentUnsupported
);
