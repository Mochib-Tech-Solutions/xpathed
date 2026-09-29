namespace Xpathed.Common.Contracts;

public sealed record PageInspection(string SessionId, string PageId, string Url, string Title,
    double ScrollY, DateTimeOffset CapturedAt);
