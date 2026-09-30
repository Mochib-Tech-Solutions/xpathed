namespace Xpathed.Common.Contracts;

public sealed record ResolvedTarget(
    string CandidateId,
    string Tag,
    string Label,
    string[] Xpaths,
    TargetState State,
    ElementGeometry Geometry,
    ActionInteractability? Interactability = null,
    TargetFrame? Frame = null,
    string? Role = null,
    string? AccessibleName = null
);
