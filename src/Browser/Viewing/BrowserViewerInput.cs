using System.Text.Json;

namespace Xpathed.Browser.Viewing;

internal sealed class BrowserViewerInput(JsonElement message)
{
    public JsonElement Message { get; private set; } = message;

    public bool MergeWheel(JsonElement next)
    {
        static bool IsWheel(JsonElement value) =>
            value.TryGetProperty("type", out var type)
            && type.ValueKind == JsonValueKind.String
            && type.ValueEquals("mouse")
            && value.TryGetProperty("event", out var action)
            && action.ValueKind == JsonValueKind.String
            && action.ValueEquals("wheel");
        static bool Delta(JsonElement value, string name, out double delta)
        {
            delta = 0;
            return value.TryGetProperty(name, out var property)
                && property.ValueKind == JsonValueKind.Number
                && property.TryGetDouble(out delta)
                && double.IsFinite(delta);
        }
        if (
            !IsWheel(Message)
            || !IsWheel(next)
            || !Delta(Message, "deltaX", out var x)
            || !Delta(Message, "deltaY", out var y)
            || !Delta(next, "deltaX", out var nextX)
            || !Delta(next, "deltaY", out var nextY)
            || Math.Sign(x) != Math.Sign(nextX)
            || Math.Sign(y) != Math.Sign(nextY)
            || !double.IsFinite(x + nextX)
            || !double.IsFinite(y + nextY)
        )
        {
            return false;
        }
        var merged = new Dictionary<string, object>();
        foreach (var property in Message.EnumerateObject())
        {
            if (!merged.TryAdd(property.Name, property.Value))
            {
                return false;
            }
            if (
                property.Name is not ("deltaX" or "deltaY")
                && (
                    !next.TryGetProperty(property.Name, out var value) || !JsonElement.DeepEquals(property.Value, value)
                )
            )
            {
                return false;
            }
        }
        if (next.EnumerateObject().Count() != merged.Count)
        {
            return false;
        }
        merged["deltaX"] = x + nextX;
        merged["deltaY"] = y + nextY;
        Message = JsonSerializer.SerializeToElement(merged);
        return true;
    }
}
