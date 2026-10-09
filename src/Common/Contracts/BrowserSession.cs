namespace Xpathed.Common.Contracts;

public sealed record BrowserSession(
    string SessionId,
    string PageId,
    string ViewPath,
    string BrowserType = "chromium",
    string Resolution = "1280x800"
);
