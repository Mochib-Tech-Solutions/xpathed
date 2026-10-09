using Microsoft.Playwright;
using Xpathed.Common.Contracts;

namespace Xpathed.Browser.Sessions;

internal sealed class BrowserPageRuntime(IPage page, long order, IBrowserPageDisplay display)
{
    private double captureStartedAt;
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public long Order { get; } = order;
    public IPage Page { get; } = page;
    public string DocumentId { get; private set; } = Guid.NewGuid().ToString("N");
    public string? CaptureId { get; set; }
    public BrowserPageCapture? Capture { get; set; }
    public Dictionary<string, ActionSelection>? ActionSelections { get; set; }

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
            }
            if (frame == Page.MainFrame || Capture?.UsesFrame(frame) == true)
            {
                InvalidateCapture();
                _ = ClearHighlightAsync();
            }
        };
        Page.FrameDetached += (_, frame) =>
        {
            if (Capture?.UsesFrame(frame) == true)
            {
                InvalidateCapture();
                _ = ClearHighlightAsync();
            }
        };
        await display.InitializeAsync(context, () => focused(this));
    }

    public Task ShowAsync() => display.ShowAsync();

    public Task<bool> HasNativeFocusAsync() => display.HasNativeFocusAsync();

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
