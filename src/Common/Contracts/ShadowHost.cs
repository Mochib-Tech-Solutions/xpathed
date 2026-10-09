using System.Text.Json.Serialization;

namespace Xpathed.Common.Contracts;

public sealed record ShadowHost(
    string Xpath,
    string Label,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? NodeId = null
);
