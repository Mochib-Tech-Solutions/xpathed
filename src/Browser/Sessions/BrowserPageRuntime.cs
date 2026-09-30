using Microsoft.Playwright;
using Xpathed.Common.Contracts;

namespace Xpathed.Browser.Sessions;

internal sealed class BrowserPageRuntime(IPage page, long order)
{
    private const string FocusWorld = "xpathed-view-state";
    private const string FocusBinding = "xpathedFocus";
    private int? focusContextId;
    private double captureStartedAt;
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public long Order { get; } = order;
    public IPage Page { get; } = page;
    public string DocumentId { get; private set; } = Guid.NewGuid().ToString("N");
    public string? CaptureId { get; set; }
    public BrowserPageCapture? Capture { get; set; }
    public Dictionary<string, ActionSelection>? ActionSelections { get; set; }
    private ICDPSession? protocol;

    public async Task InitializeAsync(IBrowserContext context, Action<BrowserPageRuntime> focused)
    {
        Page.SetDefaultTimeout(10000);
        var inputBinding = "xpathedInput" + Id;
        await Page.ExposeBindingAsync(
            inputBinding,
            (BindingSource source, double timestamp) =>
            {
                if (source.Page != Page || !double.IsFinite(timestamp) || timestamp < captureStartedAt)
                {
                    return;
                }
                var capture = Capture;
                InvalidateCapture();
                if (capture is not null)
                {
                    _ = capture.ClearHighlightAsync();
                }
            }
        );
        var inputScript = """
            (() => {
              if (globalThis[BINDING + "Installed"]) return;
              globalThis[BINDING + "Installed"] = true;
              const notify = event => { if (event.isTrusted) globalThis[BINDING](performance.timeOrigin + performance.now()); };
              addEventListener('pointerdown', notify, true);
              addEventListener('keydown', notify, true);
            })();
            """.Replace("BINDING", System.Text.Json.JsonSerializer.Serialize(inputBinding), StringComparison.Ordinal);
        await Page.AddInitScriptAsync(inputScript);
        foreach (var frame in Page.Frames)
        {
            try
            {
                await frame.EvaluateAsync(inputScript);
            }
            catch (PlaywrightException) { }
        }
        Page.FrameNavigated += (_, frame) =>
        {
            if (frame == Page.MainFrame)
            {
                DocumentId = Guid.NewGuid().ToString("N");
                focusContextId = null;
                // Playwright's CDP session restores emulated focus when the document changes.
                _ = RestoreNativeFocusAsync(focused);
            }
            InvalidateCapture();
            _ = ClearHighlightAsync();
        };
        Page.FrameDetached += (_, _) =>
        {
            InvalidateCapture();
            _ = ClearHighlightAsync();
        };
        Page.FrameAttached += (_, _) =>
        {
            InvalidateCapture();
            _ = ClearHighlightAsync();
        };
        protocol = await context.NewCDPSessionAsync(Page);
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
                focused(this);
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

    private async Task RestoreNativeFocusAsync(Action<BrowserPageRuntime> focused)
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
                focused(this);
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
        await Page.BringToFrontAsync();
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

    public async Task BeginCaptureAsync()
    {
        captureStartedAt = await Page.EvaluateAsync<double>("performance.timeOrigin + performance.now()");
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
            {
                await capture.DisposeAsync();
            }
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
    }
}
