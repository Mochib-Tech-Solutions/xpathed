namespace Xpathed.Common.Contracts;

public sealed record ActionResolution(
    string ActionId,
    int Order,
    int Step,
    string Instruction,
    string Action,
    string Outcome,
    ResolvedTarget? Target,
    string FrameId,
    string DiagnosticsReference,
    string? Code,
    string? Message
);
