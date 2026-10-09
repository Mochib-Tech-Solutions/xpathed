namespace Xpathed.Common.Contracts;

public sealed record ImageRouting(string Mode, string Status, string Reason, double? Score = null, bool Cached = false);
