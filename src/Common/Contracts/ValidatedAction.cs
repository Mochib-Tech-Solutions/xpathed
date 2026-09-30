namespace Xpathed.Common.Contracts;

public sealed record ValidatedAction(string ActionId, ResolvedTarget? Target);
