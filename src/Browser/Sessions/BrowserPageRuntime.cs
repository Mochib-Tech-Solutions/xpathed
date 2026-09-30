using Microsoft.Playwright;
using Xpathed.Common.Contracts;

namespace Xpathed.Browser.Sessions;

internal sealed class BrowserPageRuntime(IPage page, long order)
{
    private const string FocusWorld = "xpathed-view-state";
    private const string FocusBinding = "xpathedFocus";
    private int? focusContextId;
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public long Order { get; } = order;
    public IPage Page { get; } = page;
    public string DocumentId { get; private set; } = Guid.NewGuid().ToString("N");
    public string? CaptureId { get; set; }
    public BrowserPageCapture? Capture { get; set; }
    public Dictionary<string, ActionSelection>? ActionSelections { get; set; }
    public ICDPSession? Highlight { get; private set; }

    public async Task InitializeAsync(IBrowserContext context, Action<BrowserPageRuntime> focused)
    {
        Page.SetDefaultTimeout(10000);
        Page.FrameNavigated += (_, frame) =>
        {
            if (frame == Page.MainFrame)
            {
                DocumentId = Guid.NewGuid().ToString("N");
                focusContextId = null;

            }
            InvalidateCapture();
            _ = ClearHighlightAsync();
        };
        Page.FrameDetached += (_, _) => { InvalidateCapture(); _ = ClearHighlightAsync(); };
        Page.FrameAttached += (_, _) => { InvalidateCapture(); _ = ClearHighlightAsync(); };
        Highlight = await context.NewCDPSessionAsync(Page);
        await Highlight.SendAsync("DOM.enable");
        await Highlight.SendAsync("Overlay.enable");
        await Highlight.SendAsync("Emulation.setFocusEmulationEnabled", new Dictionary<string, object> { ["enabled"] = false });
        await Highlight.SendAsync("Runtime.enable");
        Highlight.Event("Runtime.bindingCalled").OnEvent += (_, message) =>
        {
            if (message is { } value && value.TryGetProperty("name", out var name) && name.GetString() == FocusBinding)
            {
                focused(this);
            }
        };
        await Highlight.SendAsync("Runtime.addBinding", new Dictionary<string, object>
        {
            ["name"] = FocusBinding,
            ["executionContextName"] = FocusWorld
        });
        await Highlight.SendAsync("Page.addScriptToEvaluateOnNewDocument", new Dictionary<string, object>
        {
            ["worldName"] = FocusWorld,
            ["runImmediately"] = true,
            ["source"] = "if (window === top) { const notify = () => { if (document.hasFocus()) globalThis.xpathedFocus(''); }; addEventListener('focus', notify); notify(); }"
        });
    }

    public async Task ShowAsync()
    {
        var window = await Highlight!.SendAsync("Browser.getWindowForTarget");
        var windowId = window!.Value.GetProperty("windowId").GetInt32();
        var bounds = window.Value.GetProperty("bounds");
        if (bounds.GetProperty("left").GetInt32() != 0 || bounds.GetProperty("top").GetInt32() != 0 ||
            Math.Abs(bounds.GetProperty("width").GetInt32() - 1280) > 1 ||
            Math.Abs(bounds.GetProperty("height").GetInt32() - 800) > 1)
        {
            await Highlight.SendAsync("Browser.setWindowBounds", new Dictionary<string, object>
            {
                ["windowId"] = windowId,
                ["bounds"] = new { windowState = "normal" }
            });
            await Highlight.SendAsync("Browser.setWindowBounds", new Dictionary<string, object>
            {
                ["windowId"] = windowId,
                ["bounds"] = new { left = 0, top = 0, width = 1280, height = 800 }
            });
        }
        await Highlight.SendAsync("Browser.setWindowBounds", new Dictionary<string, object>
        {
            ["windowId"] = windowId,
            ["bounds"] = new { windowState = "fullscreen" }
        });
        await Page.BringToFrontAsync();
    }

    public async Task<bool> HasNativeFocusAsync()
    {
        if (focusContextId is null)
        {
            var tree = await Highlight!.SendAsync("Page.getFrameTree");
            var world = await Highlight.SendAsync("Page.createIsolatedWorld", new Dictionary<string, object>
            {
                ["frameId"] = tree!.Value.GetProperty("frameTree").GetProperty("frame").GetProperty("id").GetString()!,
                ["worldName"] = FocusWorld
            });
            focusContextId = world!.Value.GetProperty("executionContextId").GetInt32();
        }
        var result = await Highlight!.SendAsync("Runtime.evaluate", new Dictionary<string, object>
        {
            ["expression"] = "document.hasFocus()",
            ["contextId"] = focusContextId.Value,
            ["returnByValue"] = true
        });
        return result!.Value.GetProperty("result").TryGetProperty("value", out var value) && value.ValueKind == System.Text.Json.JsonValueKind.True;
    }

    public void InvalidateCapture()
    {
        CaptureId = null;
        ActionSelections = null;
    }

    public async Task ClearCaptureAsync()
    {
        InvalidateCapture();
        var capture = Capture;
        Capture = null;
        if (capture is not null)
        {
            try
            { await capture.DisposeAsync(); }
            catch (PlaywrightException) { }
        }
        await ClearHighlightAsync();
    }

    public async Task ClearHighlightAsync()
    {
        if (Capture is not null)
        {
            await Capture.ClearHighlightAsync();
        }
        if (Highlight is not null)
        {
            try
            { await Highlight.SendAsync("Overlay.hideHighlight"); }
            catch (PlaywrightException) { }
        }
    }
}
