using Xpathed.Browser.Protocol;
using Xpathed.Common.Contracts;

namespace Xpathed.Browser.Sessions;

internal sealed class BrowserPageRuntime(CdpPage page, long order)
{
    private double captureStartedAt;
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public long Order { get; } = order;
    public CdpPage Page { get; } = page;
    public string DocumentId { get; private set; } = Guid.NewGuid().ToString("N");
    public string? CaptureId { get; set; }
    public BrowserPageCapture? Capture { get; set; }
    public Dictionary<string, ActionSelection>? ActionSelections { get; set; }
    public event Action? Invalidated;

    public async Task InitializeAsync()
    {
        Page.Input += timestamp =>
        {
            if (!double.IsFinite(timestamp) || timestamp < captureStartedAt)
            {
                return;
            }
            InvalidateCapture();
            _ = ClearHighlightAsync();
        };
        Page.FrameNavigated += frame =>
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
        Page.FrameDetached += frame =>
        {
            if (Capture?.UsesFrame(frame) == true)
            {
                InvalidateCapture();
                _ = ClearHighlightAsync();
            }
        };
        await Page.InitializeAsync();
    }

    public Task ShowAsync() => Page.ShowAsync();

    public Task<bool> HasNativeFocusAsync() => Page.EvaluateAsync<bool>("document.hasFocus()");

    public async Task BeginCaptureAsync() =>
        captureStartedAt = await Page.EvaluateAsync<double>("performance.timeOrigin + performance.now()");

    public void InvalidateCapture()
    {
        CaptureId = null;
        ActionSelections = null;
        Invalidated?.Invoke();
    }

    public async Task ClearCaptureAsync()
    {
        InvalidateCapture();
        var capture = Capture;
        Capture = null;
        if (capture is not null)
        {
            await capture.DisposeAsync();
        }
    }

    public async Task ClearHighlightAsync()
    {
        if (Capture is not null)
        {
            await Capture.ClearHighlightAsync();
        }
    }
}
