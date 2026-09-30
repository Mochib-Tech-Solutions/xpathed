namespace Xpathed.Common.Contracts;

public sealed record BrowserSessionState(
    string SessionId,
    string ActivePageId,
    string ViewPath,
    PageState[] Pages,
    long ActivationVersion
);
