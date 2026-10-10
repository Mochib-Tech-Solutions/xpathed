using Xpathed.Browser.Scripts;

namespace Xpathed.Browser.Tests;

public sealed class BrowserScriptsTests
{
    [Fact]
    public void PackagedScriptsLoadWithoutAStatementTerminator()
    {
        var scripts = new[]
        {
            BrowserScripts.Capture,
            BrowserScripts.Highlight,
            BrowserScripts.PrepareScreenshot,
            BrowserScripts.Input,
        };

        Assert.All(
            scripts,
            script =>
            {
                Assert.False(string.IsNullOrWhiteSpace(script));
                Assert.False(script.EndsWith(';'));
            }
        );
    }

    [Fact]
    public void CaptureIncludesItsPackagedFragmentsInOneClosure()
    {
        Assert.DoesNotContain("/* include:", BrowserScripts.Capture, StringComparison.Ordinal);
        Assert.StartsWith("async (identity) => {", BrowserScripts.Capture, StringComparison.Ordinal);
        Assert.Contains("const xpathEvidence", BrowserScripts.Capture, StringComparison.Ordinal);
        Assert.Contains("const imageSnapshot", BrowserScripts.Capture, StringComparison.Ordinal);
    }
}
