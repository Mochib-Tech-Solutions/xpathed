namespace Xpathed.Common.Contracts;

public sealed record CandidateCapture(
    string SessionId,
    string PageId,
    string DocumentId,
    string CaptureId,
    string FrameId,
    DateTimeOffset CapturedAt,
    CandidateElement[] Candidates,
    CaptureCoverage Coverage,
    int UnsupportedBoundaryCount,
    string Scope = "page"
);
