namespace Xpathed;

public sealed record BrowserSession(string SessionId, string PageId, string ViewPath);
public sealed record NavigateRequest(string Url);
public sealed record PageState(string SessionId, string PageId, string Url, string Title, int BlockedPopups);
public sealed record PageInspection(string SessionId, string PageId, string Url, string Title,
    string? DocumentId, string? Marker, double ScrollY, DateTimeOffset CapturedAt);
public sealed record InspectionResult(string InspectedBy, PageInspection Page);
