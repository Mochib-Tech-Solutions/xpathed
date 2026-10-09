namespace Xpathed.Browser.Protocol;

internal sealed record CdpDialog(string Id, string SessionId, string Type, string Message, string DefaultPrompt);
