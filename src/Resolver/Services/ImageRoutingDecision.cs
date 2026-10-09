namespace Xpathed.Resolver.Services;

internal sealed record ImageRoutingDecision(bool IncludeImage, string Reason, double? Score);
