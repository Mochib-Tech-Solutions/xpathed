using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Playwright;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

public sealed class BrowserSessions(IConfiguration configuration, ILogger<BrowserSessions> logger) : IAsyncDisposable
{
    private readonly ConcurrentDictionary<string, BrowserSessionRuntime> sessions = new();
    private readonly SemaphoreSlim creation = new(1);
    private readonly int capacity = Math.Clamp(configuration.GetValue("MaxSessions", 4), 1, 16);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<BrowserSession> CreateAsync(CancellationToken token)
    {
        await creation.WaitAsync(token);
        BrowserSessionRuntime? session = null;
        try
        {
            var slot = Enumerable.Range(0, capacity).FirstOrDefault(i => sessions.Values.All(s => s.Slot != i), -1);
            if (slot < 0)
            {
                throw new ApiException(409, "session_limit", $"Close a session before opening another (limit {capacity}).");
            }

            session = new BrowserSessionRuntime(slot, logger);
            sessions[session.Id] = session;
            await session.Gate.WaitAsync(token);
            try
            {
                await session.StartAsync(token);
                return new(session.Id, session.PageId, $"/view/{session.PageId}");
            }
            finally
            {
                session.Gate.Release();
            }
        }
        catch
        {
            if (session is not null)
            {
                await CloseAsync(session.Id);
            }

            throw;
        }
        finally
        {
            creation.Release();
        }
    }

    internal BrowserSessionRuntime Find(string pageId)
    {
        var session = sessions.Values.FirstOrDefault(s => s.PageId == pageId && s.Ready && !s.Stop.IsCancellationRequested);
        if (session is null)
        {
            throw new ApiException(404, "page_not_found", "This page is closed or no longer available. Start a fresh session.");
        }

        session.LastSeen = DateTimeOffset.UtcNow;
        return session;
    }

    private async Task<T> OnPageAsync<T>(string pageId, Func<BrowserSessionRuntime, Task<T>> operation, CancellationToken token)
    {
        var session = Find(pageId);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, session.Stop.Token);
        await session.Gate.WaitAsync(linked.Token);
        try
        {
            if (session.Stop.IsCancellationRequested)
            {
                throw new ApiException(404, "page_not_found", "This page is closed.");
            }

            var task = operation(session);
            try
            {
                return await task.WaitAsync(linked.Token);
            }
            catch (OperationCanceledException)
            {
                // A running browser command cannot be cancelled safely while retaining the page.
                await session.DisposeAsync();
                try
                {
                    await task;
                }
                catch (Exception) { }
                sessions.TryRemove(session.Id, out _);
                throw;
            }
            catch (TimeoutException)
            {
                throw new ApiException(504, "navigation_timeout", "The page did not respond in time.");
            }
            catch (PlaywrightException)
            {
                throw new ApiException(502, "browser_operation_failed", "The browser could not complete this operation.");
            }
        }
        finally
        {
            session.Gate.Release();
        }
    }

    public Task<PageState> StateAsync(string pageId, CancellationToken token) => OnPageAsync(pageId, async s =>
        new PageState(s.Id, s.PageId, s.Page!.Url, await s.Page.TitleAsync(), s.BlockedPopups, s.DocumentId), token);

    public Task<PageState> NavigateAsync(string pageId, string url, CancellationToken token)
    {
        if (url.Length > 8192 || !Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(uri.UserInfo))
        {
            throw new ApiException(400, "invalid_url", "Enter an HTTP or HTTPS address without embedded credentials.");
        }

        return OnPageAsync(pageId, async s =>
        {
            await s.Page!.GotoAsync(url, new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 20000 });
            return new PageState(s.Id, s.PageId, s.Page.Url, await s.Page.TitleAsync(), s.BlockedPopups, s.DocumentId);
        }, token);
    }

    public Task<PageInspection> InspectAsync(string pageId, CancellationToken token) => OnPageAsync(pageId, async s =>
    {
        var scrollY = await s.Page!.EvaluateAsync<double>("window.scrollY");
        return new PageInspection(s.Id, s.PageId, s.Page.Url, await s.Page.TitleAsync(), scrollY, DateTimeOffset.UtcNow);
    }, token);

    public Task<CandidateCapture> CaptureAsync(string pageId, CaptureRequest request, CancellationToken token) => OnPageAsync(pageId, async s =>
    {
        RequireDocument(s, request.DocumentId);
        await s.Highlight!.SendAsync("Overlay.hideHighlight");
        if (s.Capture is not null)
        {
            await s.Capture.DisposeAsync();
        }
        s.CaptureId = Guid.NewGuid().ToString("N");
        s.Capture = await s.Page!.EvaluateHandleAsync(BrowserCaptureScript.Capture, new
        {
            sessionId = s.Id,
            pageId = s.PageId,
            documentId = request.DocumentId,
            captureId = s.CaptureId
        });
        var result = await s.Capture.EvaluateAsync<JsonElement>("capture => capture.data");
        RequireDocument(s, request.DocumentId);
        return result.Deserialize<CandidateCapture>(JsonOptions)!;
    }, token);

    public Task<SelectionValidation> SelectAsync(string pageId, SelectionRequest request, CancellationToken token)
    {
        if (request.Action is not ("click" or "hover" or "fill" or "type" or "select" or "check" or "uncheck" or "unsupported"))
        {
            throw new ApiException(400, "invalid_action", "The requested action is not supported.");
        }
        return OnPageAsync(pageId, async s =>
        {
            RequireDocument(s, request.DocumentId);
            if (s.Capture is null || request.CaptureId != s.CaptureId)
            {
                throw new ApiException(409, "stale_capture", "This capture is no longer current.");
            }
            var result = await s.Capture.EvaluateAsync<JsonElement>("(capture, candidateId) => capture.select(candidateId)", request.CandidateId);
            RequireDocument(s, request.DocumentId);
            if (result.TryGetProperty("errorCode", out var error))
            {
                throw new ApiException(409, error.GetString()!, "The selected target is no longer valid in this capture.");
            }
            var selection = result.Deserialize<SelectionValidation>(JsonOptions)!;
            await s.Highlight!.SendAsync("Overlay.hideHighlight");
            if (selection.Target is { State.InViewport: true } target)
            {
                await s.Highlight.SendAsync("Overlay.highlightRect", new Dictionary<string, object>
                {
                    ["x"] = (int)Math.Round(target.Geometry.X),
                    ["y"] = (int)Math.Round(target.Geometry.Y),
                    ["width"] = (int)Math.Round(target.Geometry.Width),
                    ["height"] = (int)Math.Round(target.Geometry.Height),
                    ["color"] = new { r = 59, g = 130, b = 246, a = 0.18 },
                    ["outlineColor"] = new { r = 37, g = 99, b = 235, a = 1 }
                });
            }
            if (s.DocumentId != request.DocumentId)
            {
                await s.Highlight!.SendAsync("Overlay.hideHighlight");
                RequireDocument(s, request.DocumentId);
            }
            return selection;
        }, token);
    }

    private static void RequireDocument(BrowserSessionRuntime session, string documentId)
    {
        if (session.DocumentId != documentId)
        {
            throw new ApiException(409, "stale_document", "The page changed while this request was running.");
        }
    }

    public async Task CloseAsync(string sessionId)
    {
        if (!sessions.TryGetValue(sessionId, out var session))
        {
            return;
        }

        await session.Stop.CancelAsync();
        await session.Gate.WaitAsync();
        try
        {
            await session.DisposeAsync();
            sessions.TryRemove(sessionId, out _);
        }
        finally
        {
            session.Gate.Release();
        }
    }

    public async Task ReapAsync(CancellationToken token)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
        while (await timer.WaitForNextTickAsync(token))
        {
            foreach (var session in sessions.Values.Where(s => s.Stop.IsCancellationRequested || s.LastSeen < DateTimeOffset.UtcNow.AddMinutes(-15)))
            {
                await CloseAsync(session.Id);
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var id in sessions.Keys)
        {
            await CloseAsync(id);
        }
    }
}
