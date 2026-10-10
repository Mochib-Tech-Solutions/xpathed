using System.Collections.Concurrent;
using System.Text.Json;
using Xpathed.Browser.Scripts;
using Xpathed.Common.Contracts;

namespace Xpathed.Browser.Protocol;

internal sealed partial class CdpPage(
    CdpConnection connection,
    string targetId,
    string sessionId,
    BrowserResolution resolution
)
{
    private readonly ConcurrentDictionary<string, CdpFrame> frames = new();
    private readonly ConcurrentDictionary<string, byte> sessions = new();
    private readonly ConcurrentDictionary<string, byte> loaded = new();
    private readonly ConcurrentDictionary<(string Session, int Context), string> contexts = new();
    private string? mainFrameId;
    private long documentGeneration;
    private double minimumFrameTimestamp;
    private bool screencastRequested;
    private string lastTitle = "";
    private long titleRevision;
    private TaskCompletionSource dialogOpened = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public CdpConnection Connection { get; } = connection;
    public string TargetId { get; } = targetId;
    public string SessionId { get; } = sessionId;
    public BrowserResolution Resolution { get; } = resolution;
    public bool IsClosed { get; private set; }
    public int WindowId { get; private set; }
    public long DocumentGeneration => Interlocked.Read(ref documentGeneration);
    public CdpFrame MainFrame =>
        mainFrameId is not null && frames.TryGetValue(mainFrameId, out var frame)
            ? frame
            : throw new CdpException("The main document is not available.");
    public CdpFrame[] Frames => frames.Values.Where(frame => !frame.IsDetached).ToArray();
    public string Url => MainFrame.Url;
    public string Title => lastTitle;
    public event Action<CdpFrame>? FrameNavigated;
    public event Action<CdpFrame>? FrameDetached;
    public event Action<double>? Input;
    public event Action? Focused;
    public event Action<JsonElement>? ScreencastFrame;
    public event Action<CdpDialog?>? DialogChanged;
    public CdpDialog? CurrentDialog { get; private set; }

    public async Task InitializeAsync()
    {
        sessions[SessionId] = 0;
        Connection.Event += OnEvent;
        await InitializeSessionAsync(SessionId);
        await SendAsync(
            "Emulation.setDeviceMetricsOverride",
            new
            {
                width = Resolution.Width,
                height = Resolution.Height,
                deviceScaleFactor = 1,
                mobile = false,
                screenWidth = Resolution.Width,
                screenHeight = Resolution.Height,
            }
        );
        await SendAsync("Emulation.setFocusEmulationEnabled", new { enabled = true });
        var window = await Connection.SendAsync("Browser.getWindowForTarget", new { targetId = TargetId });
        WindowId = window.GetProperty("windowId").GetInt32();
        await Connection.SendAsync(
            "Browser.setWindowBounds",
            new
            {
                windowId = window.GetProperty("windowId").GetInt32(),
                bounds = new
                {
                    left = 0,
                    top = 0,
                    width = Resolution.Width,
                    height = Resolution.Height,
                    windowState = "normal",
                },
            }
        );
        var revision = Interlocked.Read(ref titleRevision);
        var target = await Connection.SendAsync("Target.getTargetInfo", new { targetId = TargetId });
        if (Interlocked.Read(ref titleRevision) == revision)
        {
            lastTitle = target.GetProperty("targetInfo").GetProperty("title").GetString()!;
        }
    }

    private async Task InitializeSessionAsync(string id)
    {
        await Connection.SendAsync("Page.enable", sessionId: id);
        await Connection.SendAsync("Page.setLifecycleEventsEnabled", new { enabled = true }, id);
        await Connection.SendAsync("Runtime.addBinding", new { name = "xpathedInput" }, id);
        await Connection.SendAsync("Runtime.addBinding", new { name = "xpathedFocus" }, id);
        await Connection.SendAsync("Page.addScriptToEvaluateOnNewDocument", new { source = BrowserScripts.Input }, id);
        var tree = await Connection.SendAsync("Page.getFrameTree", sessionId: id);
        AddTree(tree.GetProperty("frameTree"), id);
        await Connection.SendAsync("Runtime.enable", sessionId: id);
        await Connection.SendAsync(
            "Target.setAutoAttach",
            new
            {
                autoAttach = true,
                waitForDebuggerOnStart = true,
                flatten = true,
                filter = new object[] { new { type = "iframe" }, new { exclude = true } },
            },
            id
        );
        await Connection.SendAsync("Runtime.runIfWaitingForDebugger", sessionId: id);
        foreach (var frame in Frames.Where(frame => frame.SessionId == id))
        {
            try
            {
                await frame.EvaluateAsync<JsonElement>("() => {" + BrowserScripts.Input + "}");
            }
            catch (CdpException) { }
        }
    }

    public Task<JsonElement> SendAsync(string method, object? parameters = null) =>
        Connection.SendAsync(method, parameters, SessionId);

    public Task<T> EvaluateAsync<T>(string expression, object? argument = null) =>
        MainFrame.EvaluateAsync<T>(expression, argument);

    public async Task<CdpFrame?> FindFrameAsync(string id)
    {
        for (var attempt = 0; attempt < 100; attempt++)
        {
            if (frames.TryGetValue(id, out var frame) && frame.Context is not null && !frame.IsDetached)
            {
                return frame;
            }
            await Task.Delay(10);
        }
        return null;
    }

    public async Task NavigateAsync(string url)
    {
        var result = await SendAsync("Page.navigate", new { url });
        if (result.TryGetProperty("errorText", out _))
        {
            throw new CdpException("The browser navigation failed.");
        }
        if (result.TryGetProperty("loaderId", out var loader))
        {
            var timer = System.Diagnostics.Stopwatch.StartNew();
            while (!loaded.ContainsKey(loader.GetString()!))
            {
                if (CurrentDialog is not null)
                {
                    return;
                }
                if (timer.ElapsedMilliseconds >= 20000)
                {
                    throw new TimeoutException();
                }
                if (IsClosed)
                {
                    throw new CdpException("The page closed during navigation.");
                }
                await Task.Delay(10);
            }
        }
    }

    public async Task ShowAsync()
    {
        await Connection.SendAsync(
            "Browser.setWindowBounds",
            new { windowId = WindowId, bounds = new { windowState = "normal" } }
        );
        await SendAsync("Page.bringToFront");
    }

    public Task MinimizeAsync() =>
        Connection.SendAsync(
            "Browser.setWindowBounds",
            new { windowId = WindowId, bounds = new { windowState = "minimized" } }
        );

    public async Task CloseAsync()
    {
        MarkClosed();
        await Connection.SendAsync("Target.closeTarget", new { targetId = TargetId });
    }

    public void MarkClosed()
    {
        IsClosed = true;
        Connection.Event -= OnEvent;
        foreach (var frame in frames.Values)
        {
            frame.IsDetached = true;
        }
    }
}
