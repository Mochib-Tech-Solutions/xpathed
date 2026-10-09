using System.Text.Json.Serialization;

namespace Xpathed.Common.Contracts;

public sealed record FrameAncestor(
    string FrameId,
    string Xpath,
    string Label,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ShadowHost[]? ShadowChain = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? NodeId = null
);
