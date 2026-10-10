using System.Text.Json;
using Xpathed.Browser.Viewing;

namespace Xpathed.Browser.Tests;

public sealed class BrowserViewerInputTests
{
    [Theory]
    [InlineData("pageId", "\"other\"")]
    [InlineData("documentId", "\"other\"")]
    [InlineData("x", "200")]
    [InlineData("y", "200")]
    [InlineData("modifiers", "2")]
    [InlineData("buttons", "1")]
    [InlineData("button", "\"left\"")]
    [InlineData("event", "\"down\"")]
    [InlineData("type", "7")]
    [InlineData("deltaY", "-10")]
    [InlineData("deltaX", "\"invalid\"")]
    [InlineData("deltaY", "1e400")]
    public void DifferentContextOrInvalidScrollCannotMerge(string property, string value)
    {
        var original = Wheel();
        var input = new BrowserViewerInput(original);
        var next = Wheel(property, value);

        Assert.False(input.MergeWheel(next));
        Assert.True(JsonElement.DeepEquals(original, input.Message));
        Assert.False(new BrowserViewerInput(next).MergeWheel(original));
    }

    [Fact]
    public void ScrollCannotMergeAcrossZeroOrReverseDirection()
    {
        var input = new BrowserViewerInput(Wheel("deltaY", "0"));
        Assert.False(input.MergeWheel(Wheel()));
        input = new BrowserViewerInput(Wheel("deltaX", "10"));
        Assert.False(input.MergeWheel(Wheel("deltaX", "-10")));
    }

    [Fact]
    public void ScrollOverflowCannotReplaceValidInput()
    {
        var original = Wheel("deltaY", "1e308");
        var input = new BrowserViewerInput(original);
        Assert.False(input.MergeWheel(original));
        Assert.True(JsonElement.DeepEquals(original, input.Message));
    }

    private static JsonElement Wheel(string? property = null, string? value = null)
    {
        var fields = new Dictionary<string, JsonElement>();
        using var document = JsonDocument.Parse(
            """
            {"type":"mouse","event":"wheel","pageId":"page","documentId":"document",
            "x":100,"y":100,"button":"none","buttons":0,"modifiers":0,"deltaX":0,"deltaY":10}
            """
        );
        foreach (var field in document.RootElement.EnumerateObject())
        {
            fields[field.Name] = field.Value;
        }
        if (property is not null)
        {
            using var replacement = JsonDocument.Parse(value!);
            fields[property] = replacement.RootElement.Clone();
        }
        return JsonSerializer.SerializeToElement(fields);
    }
}
