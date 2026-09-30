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
                return new(session.Id, session.ActivePageId, session.ViewPath);
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

    internal BrowserSessionRuntime FindSession(string sessionId)
    {
        if (!sessions.TryGetValue(sessionId, out var session) || !session.Ready || session.Stop.IsCancellationRequested)
        {
            throw new ApiException(404, "session_not_found", "This session is closed or no longer available. Start a fresh session.");
        }

        session.LastSeen = DateTimeOffset.UtcNow;
        return session;
    }

    private Task<T> OnPageAsync<T>(string pageId, Func<BrowserSessionRuntime, BrowserPageRuntime, Task<T>> operation, CancellationToken token, bool requireActive = true)
    {
        var session = sessions.Values.FirstOrDefault(s => s.Pages.ContainsKey(pageId) && s.Ready && !s.Stop.IsCancellationRequested)
            ?? throw new ApiException(404, "page_not_found", "This page is closed or no longer available.");
        return OnSessionAsync(session, s =>
        {
            if (!s.Pages.TryGetValue(pageId, out var page) || page.Page.IsClosed)
            {
                throw new ApiException(404, "page_not_found", "This page is closed.");
            }
            if (requireActive)
            {
                RequireActive(s, page);
            }

            return operation(s, page);
        }, token);
    }

    private async Task<T> OnSessionAsync<T>(BrowserSessionRuntime session, Func<BrowserSessionRuntime, Task<T>> operation, CancellationToken token)
    {
        session.LastSeen = DateTimeOffset.UtcNow;
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

    public Task<BrowserSessionState> SessionStateAsync(string sessionId, CancellationToken token) =>
        OnSessionAsync(FindSession(sessionId), s => s.StateAsync(), token);

    public Task<BrowserSessionState> NewPageAsync(string sessionId, CancellationToken token) =>
        OnSessionAsync(FindSession(sessionId), async s =>
        {
            await s.NewPageAsync();
            return await s.StateAsync();
        }, token);

    public Task<BrowserSessionState> ActivateAsync(string pageId, CancellationToken token) =>
        OnPageAsync(pageId, async (s, page) =>
        {
            await s.ActivateAsync(page);
            return await s.StateAsync();
        }, token, requireActive: false);

    public Task<BrowserSessionState> ClosePageAsync(string pageId, CancellationToken token) =>
        OnPageAsync(pageId, async (s, page) =>
        {
            await s.ClosePageAsync(page);
            return await s.StateAsync();
        }, token, requireActive: false);

    public Task<PageState> StateAsync(string pageId, CancellationToken token) => OnPageAsync(pageId, async (s, page) =>
        new PageState(s.Id, page.Id, page.Page.Url, await page.Page.TitleAsync(), s.BlockedPopups, page.DocumentId), token, requireActive: false);

    public Task<PageState> NavigateAsync(string pageId, string url, CancellationToken token)
    {
        if (url.Length > 8192 || !Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(uri.UserInfo))
        {
            throw new ApiException(400, "invalid_url", "Enter an HTTP or HTTPS address without embedded credentials.");
        }

        return OnPageAsync(pageId, async (s, page) =>
        {
            await page.Page.GotoAsync(url, new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 20000 });
            return new PageState(s.Id, page.Id, page.Page.Url, await page.Page.TitleAsync(), s.BlockedPopups, page.DocumentId);
        }, token);
    }

    public Task<PageInspection> InspectAsync(string pageId, CancellationToken token) => OnPageAsync(pageId, async (s, page) =>
    {
        var scrollY = await page.Page.EvaluateAsync<double>("window.scrollY");
        RequireActive(s, page);
        return new PageInspection(s.Id, page.Id, page.Page.Url, await page.Page.TitleAsync(), scrollY, DateTimeOffset.UtcNow);
    }, token);

    public Task<CandidateCapture> CaptureAsync(string pageId, CaptureRequest request, CancellationToken token) => OnPageAsync(pageId, async (s, page) =>
    {
        await RequireFocusedDocumentAsync(s, page, request.DocumentId);
        await page.ClearCaptureAsync();
        page.CaptureId = Guid.NewGuid().ToString("N");
        var captureId = page.CaptureId;
        page.Capture = await page.Page.EvaluateHandleAsync(BrowserCaptureScript.Capture, new
        {
            sessionId = s.Id,
            pageId = page.Id,
            documentId = request.DocumentId,
            captureId
        });
        var result = await page.Capture.EvaluateAsync<JsonElement>("capture => capture.data");
        await RequireFocusedDocumentAsync(s, page, request.DocumentId);
        if (page.CaptureId != captureId)
        {
            throw new ApiException(409, "stale_capture", "This capture is no longer current.");
        }

        return result.Deserialize<CandidateCapture>(JsonOptions)!;
    }, token);

    public Task<SelectionValidation> SelectAsync(string pageId, SelectionRequest request, CancellationToken token)
    {
        if (request.Action is not ("click" or "hover" or "fill" or "type" or "select" or "check" or "uncheck" or "unsupported"))
        {
            throw new ApiException(400, "invalid_action", "The requested action is not supported.");
        }
        return OnPageAsync(pageId, async (s, page) =>
        {
            await RequireFocusedDocumentAsync(s, page, request.DocumentId);
            if (page.Capture is null || request.CaptureId != page.CaptureId)
            {
                throw new ApiException(409, "stale_capture", "This capture is no longer current.");
            }
            var result = await page.Capture.EvaluateAsync<JsonElement>("(capture, selection) => capture.select(selection.candidateId, selection.action)", new { candidateId = request.CandidateId, action = request.Action });
            await RequireFocusedDocumentAsync(s, page, request.DocumentId);
            if (request.CaptureId != page.CaptureId)
            {
                throw new ApiException(409, "stale_capture", "This capture is no longer current.");
            }

            if (result.TryGetProperty("errorCode", out var error))
            {
                throw new ApiException(409, error.GetString()!, "The selected target is no longer valid in this capture.");
            }
            var selection = result.Deserialize<SelectionValidation>(JsonOptions)!;
            await page.Highlight!.SendAsync("Overlay.hideHighlight");
            if (selection.Target is { State.InViewport: true } target)
            {
                await page.Highlight.SendAsync("Overlay.highlightRect", new Dictionary<string, object>
                {
                    ["x"] = (int)Math.Round(target.Geometry.X),
                    ["y"] = (int)Math.Round(target.Geometry.Y),
                    ["width"] = (int)Math.Round(target.Geometry.Width),
                    ["height"] = (int)Math.Round(target.Geometry.Height),
                    ["color"] = new { r = 59, g = 130, b = 246, a = 0.18 },
                    ["outlineColor"] = new { r = 37, g = 99, b = 235, a = 1 }
                });
            }
            try
            {
                await RequireFocusedDocumentAsync(s, page, request.DocumentId);
                if (request.CaptureId != page.CaptureId)
                {
                    throw new ApiException(409, "stale_capture", "This capture is no longer current.");
                }
            }
            catch (ApiException)
            {
                await page.ClearHighlightAsync();
                throw;
            }
            return selection;
        }, token);
    }

    private static void RequireActive(BrowserSessionRuntime session, BrowserPageRuntime page)
    {
        if (session.ActivePageId != page.Id || session.HasPendingPages)
        {
            throw new ApiException(409, "inactive_page", "The active browser tab changed. Resolve the instruction on the current tab.");
        }
    }

    private static void RequireDocument(BrowserSessionRuntime session, BrowserPageRuntime page, string documentId)
    {
        RequireActive(session, page);
        if (page.DocumentId != documentId)
        {
            throw new ApiException(409, "stale_document", "The page changed while this request was running.");
        }
    }

    private static async Task RequireFocusedDocumentAsync(BrowserSessionRuntime session, BrowserPageRuntime page, string documentId)
    {
        RequireDocument(session, page, documentId);
        if (!await page.HasNativeFocusAsync())
        {
            page.InvalidateCapture();
            throw new ApiException(409, "inactive_page", "The active browser tab changed. Resolve the instruction on the current tab.");
        }
        RequireDocument(session, page, documentId);
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
