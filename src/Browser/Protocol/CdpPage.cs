using System.Collections.Concurrent;
using System.Text.Json;
using Xpathed.Common.Contracts;

namespace Xpathed.Browser.Protocol;

internal sealed class CdpPage(CdpConnection connection, string targetId, string sessionId, BrowserResolution resolution)
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
    private const string InputScript =
        "(() => { if (globalThis.__xpathedInputInstalled) return; globalThis.__xpathedInputInstalled=true; const send=globalThis.xpathedInput; globalThis.xpathedInput=value=>send(String(value)); const focus=globalThis.focus; globalThis.focus=function(...args){const result=Reflect.apply(focus,this,args);if(this===globalThis)globalThis.xpathedFocus('');return result;}; const notify=e=>{if(e.isTrusted)globalThis.xpathedInput(performance.timeOrigin+performance.now());}; addEventListener('pointerdown',notify,true); addEventListener('keydown',notify,true); addEventListener('focus',()=>{if(document.hasFocus())globalThis.xpathedFocus('');}); })();";

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
        await Connection.SendAsync("Page.addScriptToEvaluateOnNewDocument", new { source = InputScript }, id);
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
                await frame.EvaluateAsync<JsonElement>("() => {" + InputScript + "}");
            }
            catch (CdpException) { }
        }
    }

    private CdpFrame AddFrame(JsonElement data, string id)
    {
        var frameId = data.GetProperty("id").GetString()!;
        var frame = frames.GetOrAdd(frameId, value => new CdpFrame(this, value, id));
        if (frame.SessionId != id)
        {
            frame.Context = null;
        }
        frame.SessionId = id;
        frame.IsDetached = false;
        frame.Url = data.GetProperty("url").GetString()!;
        if (data.TryGetProperty("parentId", out var parent))
        {
            frame.ParentId = parent.GetString();
        }
        else if (id == SessionId)
        {
            mainFrameId = frameId;
        }
        return frame;
    }

    private void AddTree(JsonElement tree, string id)
    {
        var pending = new Stack<JsonElement>();
        pending.Push(tree);
        while (pending.TryPop(out var current))
        {
            AddFrame(current.GetProperty("frame"), id);
            if (current.TryGetProperty("childFrames", out var children))
            {
                foreach (var child in children.EnumerateArray())
                {
                    pending.Push(child);
                }
            }
        }
    }

    private void OnEvent(string? id, string method, JsonElement data)
    {
        if (
            id is null
            && method == "Target.targetInfoChanged"
            && data.GetProperty("targetInfo").GetProperty("targetId").GetString() == TargetId
        )
        {
            Interlocked.Increment(ref titleRevision);
            lastTitle = data.GetProperty("targetInfo").GetProperty("title").GetString()!;
        }
        if (id is null || !sessions.ContainsKey(id) || IsClosed)
        {
            return;
        }
        switch (method)
        {
            case "Target.attachedToTarget":
                if (data.GetProperty("targetInfo").GetProperty("type").GetString() == "iframe")
                {
                    var child = data.GetProperty("sessionId").GetString()!;
                    sessions[child] = 0;
                    _ = InitializeChildAsync(child);
                }
                break;
            case "Target.detachedFromTarget":
                var detachedSession = data.GetProperty("sessionId").GetString()!;
                sessions.TryRemove(detachedSession, out _);
                foreach (var frame in Frames.Where(frame => frame.SessionId == detachedSession))
                {
                    frame.IsDetached = true;
                    FrameDetached?.Invoke(frame);
                }
                break;
            case "Page.frameAttached":
                var attached = frames.GetOrAdd(
                    data.GetProperty("frameId").GetString()!,
                    value => new CdpFrame(this, value, id)
                );
                attached.ParentId = data.GetProperty("parentFrameId").GetString();
                break;
            case "Page.frameNavigated":
                var navigated = AddFrame(data.GetProperty("frame"), id);
                navigated.Context = null;
                if (navigated.Id == mainFrameId)
                {
                    BeginFrameGeneration();
                }
                FrameNavigated?.Invoke(navigated);
                break;
            case "Page.navigatedWithinDocument":
                if (frames.TryGetValue(data.GetProperty("frameId").GetString()!, out var within))
                {
                    within.Url = data.GetProperty("url").GetString()!;
                    if (within.Id == mainFrameId)
                    {
                        BeginFrameGeneration();
                    }
                    FrameNavigated?.Invoke(within);
                }
                break;
            case "Page.frameDetached":
                if (data.GetProperty("reason").GetString() == "swap")
                {
                    break;
                }
                if (frames.TryGetValue(data.GetProperty("frameId").GetString()!, out var detached))
                {
                    detached.IsDetached = true;
                    FrameDetached?.Invoke(detached);
                }
                break;
            case "Runtime.executionContextCreated":
                var context = data.GetProperty("context");
                if (
                    context.TryGetProperty("auxData", out var aux)
                    && aux.TryGetProperty("isDefault", out var isDefault)
                    && isDefault.GetBoolean()
                    && aux.TryGetProperty("frameId", out var contextFrame)
                )
                {
                    var frame = frames.GetOrAdd(contextFrame.GetString()!, value => new CdpFrame(this, value, id));
                    frame.SessionId = id;
                    frame.Context = new(
                        id,
                        context.GetProperty("id").GetInt32(),
                        context.GetProperty("uniqueId").GetString()!
                    );
                    contexts[(id, frame.Context.Id)] = frame.Id;
                }
                break;
            case "Runtime.executionContextDestroyed":
                var destroyedContext = data.GetProperty("executionContextId").GetInt32();
                if (
                    contexts.TryRemove((id, destroyedContext), out var destroyed)
                    && frames.TryGetValue(destroyed, out var destroyedFrame)
                    && destroyedFrame.SessionId == id
                    && destroyedFrame.Context?.Id == destroyedContext
                )
                {
                    destroyedFrame.Context = null;
                }
                break;
            case "Runtime.executionContextsCleared":
                foreach (var frame in Frames.Where(frame => frame.SessionId == id))
                {
                    frame.Context = null;
                }
                break;
            case "Runtime.bindingCalled":
                if (
                    data.GetProperty("name").GetString() == "xpathedFocus"
                    && contexts.TryGetValue(
                        (id, data.GetProperty("executionContextId").GetInt32()),
                        out var focusedFrame
                    )
                    && focusedFrame == mainFrameId
                )
                {
                    Focused?.Invoke();
                }
                if (
                    data.GetProperty("name").GetString() == "xpathedInput"
                    && double.TryParse(
                        data.GetProperty("payload").GetString(),
                        System.Globalization.CultureInfo.InvariantCulture,
                        out var timestamp
                    )
                )
                {
                    Input?.Invoke(timestamp);
                }
                break;
            case "Page.lifecycleEvent":
                if (data.GetProperty("name").GetString() == "DOMContentLoaded")
                {
                    loaded[data.GetProperty("loaderId").GetString()!] = 0;
                }
                break;
            case "Page.screencastFrame":
                if (
                    id == SessionId
                    && data.GetProperty("metadata").TryGetProperty("timestamp", out var frameTimestamp)
                    && frameTimestamp.GetDouble() >= Volatile.Read(ref minimumFrameTimestamp)
                )
                {
                    ScreencastFrame?.Invoke(data);
                }
                _ = AcknowledgeFrameAsync(id, data.GetProperty("sessionId").GetInt32());
                break;
            case "Page.javascriptDialogOpening":
                CurrentDialog = new(
                    Guid.NewGuid().ToString("N"),
                    id,
                    data.GetProperty("type").GetString()!,
                    data.GetProperty("message").GetString()!,
                    data.TryGetProperty("defaultPrompt", out var prompt) ? prompt.GetString()! : ""
                );
                DialogChanged?.Invoke(CurrentDialog);
                dialogOpened.TrySetResult();
                break;
            case "Page.javascriptDialogClosed":
                CurrentDialog = null;
                dialogOpened = new(TaskCreationOptions.RunContinuationsAsynchronously);
                DialogChanged?.Invoke(null);
                if (double.IsPositiveInfinity(Volatile.Read(ref minimumFrameTimestamp)))
                {
                    _ = RefreshFrameGenerationAsync(Interlocked.Read(ref documentGeneration));
                }
                break;
        }
    }

    private void BeginFrameGeneration()
    {
        var generation = Interlocked.Increment(ref documentGeneration);
        Volatile.Write(ref minimumFrameTimestamp, double.PositiveInfinity);
        _ = RefreshFrameGenerationAsync(generation);
    }

    private async Task RefreshFrameGenerationAsync(long generation)
    {
        try
        {
            var timestamp = await EvaluateAsync<double>(
                "() => new Promise(resolve => requestAnimationFrame(() => resolve((performance.timeOrigin + performance.now()) / 1000)))"
            );
            if (generation != Interlocked.Read(ref documentGeneration) || IsClosed)
            {
                return;
            }
            Volatile.Write(ref minimumFrameTimestamp, timestamp);
            if (screencastRequested)
            {
                await SendAsync("Page.stopScreencast");
                await StartScreencastAsync();
            }
        }
        catch (CdpException) { }
        catch (OperationCanceledException) { }
    }

    private async Task InitializeChildAsync(string id)
    {
        try
        {
            await InitializeSessionAsync(id);
        }
        catch (CdpException)
        {
            sessions.TryRemove(id, out _);
        }
        catch (OperationCanceledException) { }
    }

    private async Task AcknowledgeFrameAsync(string id, int frameId)
    {
        try
        {
            await Connection.SendAsync("Page.screencastFrameAck", new { sessionId = frameId }, id);
        }
        catch (CdpException) { }
        catch (OperationCanceledException) { }
    }

    public async Task AnswerDialogAsync(string dialogId, bool accept, string? promptText)
    {
        var dialog = CurrentDialog;
        if (dialog is null || dialog.Id != dialogId)
        {
            throw new CdpException("The dialog is no longer current.");
        }
        await Connection.SendAsync("Page.handleJavaScriptDialog", new { accept, promptText }, dialog.SessionId);
    }

    public Task<JsonElement> SendAsync(string method, object? parameters = null) =>
        Connection.SendAsync(method, parameters, SessionId);

    public async Task SendInputAsync(
        string method,
        object parameters,
        bool release = false,
        long? expectedGeneration = null,
        Action? beforeSend = null
    )
    {
        EnsureGeneration(expectedGeneration);
        if (CurrentDialog is not null && !release)
        {
            throw new CdpDialogPendingException();
        }
        var interrupted = dialogOpened.Task;
        var command = Connection.SendAsync(
            method,
            parameters,
            SessionId,
            () =>
            {
                EnsureGeneration(expectedGeneration);
                if (CurrentDialog is not null && !release)
                {
                    throw new CdpDialogPendingException();
                }
                beforeSend?.Invoke();
            }
        );
        if (await Task.WhenAny(command, interrupted) == command)
        {
            await command;
        }
        else
        {
            _ = ObserveInputCompletionAsync(command);
        }
    }

    public void EnsureGeneration(long? expected)
    {
        if (IsClosed || (expected is not null && expected != DocumentGeneration))
        {
            throw new CdpException("The displayed document changed before input dispatch.");
        }
    }

    public async Task<JsonElement> DocumentCommandAsync(Func<Task<JsonElement>> send)
    {
        var interrupted = dialogOpened.Task;
        if (CurrentDialog is not null)
        {
            throw new CdpDialogPendingException();
        }
        var command = send();
        if (await Task.WhenAny(command, interrupted) == command)
        {
            return await command;
        }
        _ = ObserveInputCompletionAsync(command);
        throw new CdpDialogPendingException();
    }

    private static async Task ObserveInputCompletionAsync(Task command)
    {
        try
        {
            await command;
        }
        catch (CdpException) { }
        catch (OperationCanceledException) { }
    }

    public Task<T> EvaluateAsync<T>(string expression, object? argument = null) =>
        MainFrame.EvaluateAsync<T>(expression, argument);

    public Task<string> TitleAsync() => Task.FromResult(lastTitle);

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

    public async Task StartScreencastAsync()
    {
        screencastRequested = true;
        if (double.IsPositiveInfinity(Volatile.Read(ref minimumFrameTimestamp)))
        {
            return;
        }
        await SendAsync(
            "Page.startScreencast",
            new
            {
                format = "jpeg",
                quality = 80,
                maxWidth = Resolution.Width,
                maxHeight = Resolution.Height,
                everyNthFrame = 1,
            }
        );
    }

    public Task StopScreencastAsync()
    {
        screencastRequested = false;
        return SendAsync("Page.stopScreencast");
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
