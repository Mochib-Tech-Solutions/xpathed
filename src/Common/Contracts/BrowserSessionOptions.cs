namespace Xpathed.Common.Contracts;

public sealed record BrowserSessionOptions(
    string DefaultBrowserType,
    string[] BrowserTypes,
    string DefaultResolution,
    BrowserResolution[] Resolutions
);
