namespace Xpathed.Common.Contracts;

public sealed record TargetFrame(string Id, string DocumentId, FrameAncestor[] Chain);
