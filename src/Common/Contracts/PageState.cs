namespace Xpathed.Common.Contracts;

public sealed record PageState(
    string SessionId,
    string PageId,
    string Url,
    string Title,
    int BlockedPopups,
    string DocumentId
);
