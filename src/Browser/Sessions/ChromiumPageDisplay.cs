using Microsoft.Playwright;

namespace Xpathed.Browser.Sessions;

internal sealed class ChromiumPageDisplay(IPage page) : IBrowserPageDisplay
{
    private const string FocusWorld = "xpathed-view-state";
    private const string FocusBinding = "xpathedFocus";
    private int? focusContextId;
    private ICDPSession? protocol;

    public async Task InitializeAsync(IBrowserContext context, Action focused)
    {
        page.FrameNavigated += (_, frame) =>
        {
            if (frame == page.MainFrame)
            {
                focusContextId = null;
                _ = RestoreNativeFocusAsync(focused);
            }
        };
        protocol = await context.NewCDPSessionAsync(page);
        await protocol.SendAsync(
            "Emulation.setFocusEmulationEnabled",
            new Dictionary<string, object> { ["enabled"] = false }
        );
        await protocol.SendAsync("Runtime.enable");

        await protocol.SendAsync("Page.enable");
        protocol.Event("Runtime.bindingCalled").OnEvent += (_, message) =>
        {
            if (message is { } value && value.TryGetProperty("name", out var name) && name.GetString() == FocusBinding)
            {
                focused();
            }
        };
        await protocol.SendAsync(
            "Runtime.addBinding",
            new Dictionary<string, object> { ["name"] = FocusBinding, ["executionContextName"] = FocusWorld }
        );
        await protocol.SendAsync(
            "Page.addScriptToEvaluateOnNewDocument",
            new Dictionary<string, object>
            {
                ["worldName"] = FocusWorld,
                ["runImmediately"] = true,
                ["source"] =
                    "if (window === top) { const notify = () => { if (document.hasFocus()) globalThis.xpathedFocus(''); }; addEventListener('focus', notify); notify(); }",
            }
        );
    }

    private async Task RestoreNativeFocusAsync(Action focused)
    {
        if (protocol is null)
        {
            return;
        }
        try
        {
            await protocol.SendAsync(
                "Emulation.setFocusEmulationEnabled",
                new Dictionary<string, object> { ["enabled"] = false }
            );
            if (await HasNativeFocusAsync())
            {
                focused();
            }
        }
        catch (PlaywrightException) { }
    }

    public async Task ShowAsync()
    {
        var window = await protocol!.SendAsync("Browser.getWindowForTarget");
        var windowId = window!.Value.GetProperty("windowId").GetInt32();
        var bounds = window.Value.GetProperty("bounds");
        if (
            bounds.GetProperty("left").GetInt32() != 0
            || bounds.GetProperty("top").GetInt32() != 0
            || Math.Abs(bounds.GetProperty("width").GetInt32() - 1280) > 1
            || Math.Abs(bounds.GetProperty("height").GetInt32() - 800) > 1
        )
        {
            await protocol.SendAsync(
                "Browser.setWindowBounds",
                new Dictionary<string, object> { ["windowId"] = windowId, ["bounds"] = new { windowState = "normal" } }
            );
            await protocol.SendAsync(
                "Browser.setWindowBounds",
                new Dictionary<string, object>
                {
                    ["windowId"] = windowId,
                    ["bounds"] = new
                    {
                        left = 0,
                        top = 0,
                        width = 1280,
                        height = 800,
                    },
                }
            );
        }
        await protocol.SendAsync(
            "Browser.setWindowBounds",
            new Dictionary<string, object> { ["windowId"] = windowId, ["bounds"] = new { windowState = "fullscreen" } }
        );
        await page.BringToFrontAsync();
    }

    public async Task<bool> HasNativeFocusAsync()
    {
        if (focusContextId is null)
        {
            var tree = await protocol!.SendAsync("Page.getFrameTree");
            var world = await protocol.SendAsync(
                "Page.createIsolatedWorld",
                new Dictionary<string, object>
                {
                    ["frameId"] = tree!
                        .Value.GetProperty("frameTree")
                        .GetProperty("frame")
                        .GetProperty("id")
                        .GetString()!,
                    ["worldName"] = FocusWorld,
                }
            );
            focusContextId = world!.Value.GetProperty("executionContextId").GetInt32();
        }
        var result = await protocol!.SendAsync(
            "Runtime.evaluate",
            new Dictionary<string, object>
            {
                ["expression"] = "document.hasFocus()",
                ["contextId"] = focusContextId.Value,
                ["returnByValue"] = true,
            }
        );
        return result!.Value.GetProperty("result").TryGetProperty("value", out var value)
            && value.ValueKind == System.Text.Json.JsonValueKind.True;
    }
}
