namespace Xpathed.Browser.Scripts;

internal static class BrowserScripts
{
    public static string Capture { get; } = ReadCapture();
    public static string Highlight { get; } = Read("highlight");
    public static string PrepareScreenshot { get; } = Read("prepare-screenshot");
    public static string Input { get; } = Read("input");

    private static string ReadCapture()
    {
        var script = Read("capture");
        // Fragments share one capture closure, including its retained nodes and privacy state.
        foreach (
            var name in new[]
            {
                "context",
                "semantics",
                "geometry",
                "readiness",
                "candidates",
                "locators",
                "xpath",
                "images",
            }
        )
        {
            script = script.Replace(
                $"/* include:capture-{name} */",
                Read($"capture-{name}") + ";",
                StringComparison.Ordinal
            );
        }
        return script;
    }

    private static string Read(string name)
    {
        using var resource =
            typeof(BrowserScripts).Assembly.GetManifestResourceStream($"Xpathed.Browser.Scripts.{name}.js")
            ?? throw new InvalidOperationException($"The browser script {name}.js is missing.");
        using var reader = new StreamReader(resource);
        // Evaluated scripts are expressions inserted inside parentheses.
        return reader.ReadToEnd().TrimEnd().TrimEnd(';');
    }
}
