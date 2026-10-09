namespace Xpathed.Common.Contracts;

public sealed record CaptureImageResult(
    string SessionId,
    string PageId,
    string DocumentId,
    string CaptureId,
    CaptureImage Image
);
