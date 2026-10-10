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
}
