using System.Collections.Concurrent;
using System.Text.Json;
using Xpathed.Browser.Scripts;
using Xpathed.Common.Contracts;

namespace Xpathed.Browser.Protocol;

internal sealed partial class CdpPage
{
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
                // Runtime lifecycle events own context invalidation; creation can precede this event.
                var navigated = AddFrame(data.GetProperty("frame"), id);
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
                    data.GetProperty("name").GetString() == "xpathedCursor"
                    && contexts.TryGetValue(
                        (id, data.GetProperty("executionContextId").GetInt32()),
                        out var cursorFrame
                    )
                    && frames.TryGetValue(cursorFrame, out var currentFrame)
                    && !currentFrame.IsDetached
                    && currentFrame.Context?.SessionId == id
                    && currentFrame.Context.Id == data.GetProperty("executionContextId").GetInt32()
                    && data.GetProperty("payload").GetString() is { Length: <= 32 } cursor
                )
                {
                    CursorChanged?.Invoke(cursor);
                }
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
                    && !Volatile.Read(ref screenshotInProgress)
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
}
