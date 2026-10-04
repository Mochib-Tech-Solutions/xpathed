using System.Collections.Concurrent;
using Microsoft.Playwright;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

public sealed class BrowserSessions(IConfiguration configuration, ILogger<BrowserSessions> logger) : IAsyncDisposable
{
    private readonly ConcurrentDictionary<string, BrowserSessionRuntime> sessions = new();
    private readonly SemaphoreSlim creation = new(1);
    private readonly int capacity = Math.Clamp(configuration.GetValue("MaxSessions", 4), 1, 16);

    public async Task<BrowserSession> CreateAsync(CancellationToken token)
    {
        await creation.WaitAsync(token);
        BrowserSessionRuntime? session = null;
        try
        {
            var slot = Enumerable.Range(0, capacity).FirstOrDefault(i => sessions.Values.All(s => s.Slot != i), -1);
            if (slot < 0)
            {
                throw new ApiException(
                    409,
                    "session_limit",
                    $"Close a session before opening another (limit {capacity})."
                );
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
            throw new ApiException(
                404,
                "session_not_found",
                "This session is closed or no longer available. Start a fresh session."
            );
        }

        session.LastSeen = DateTimeOffset.UtcNow;
        return session;
    }

    private Task<T> OnPageAsync<T>(
        string pageId,
        Func<BrowserSessionRuntime, BrowserPageRuntime, Task<T>> operation,
        CancellationToken token,
        bool requireActive = true
    )
    {
        var session =
            sessions.Values.FirstOrDefault(s =>
                s.Pages.ContainsKey(pageId) && s.Ready && !s.Stop.IsCancellationRequested
            ) ?? throw new ApiException(404, "page_not_found", "This page is closed or no longer available.");
        return OnSessionAsync(
            session,
            s =>
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
            },
            token
        );
    }

    private async Task<T> OnSessionAsync<T>(
        BrowserSessionRuntime session,
        Func<BrowserSessionRuntime, Task<T>> operation,
        CancellationToken token
    )
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
                throw new ApiException(
                    502,
                    "browser_operation_failed",
                    "The browser could not complete this operation."
                );
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
        OnSessionAsync(
            FindSession(sessionId),
            async s =>
            {
                await s.NewPageAsync();
                return await s.StateAsync();
            },
            token
        );

    public Task<BrowserSessionState> ActivateAsync(string pageId, CancellationToken token) =>
        OnPageAsync(
            pageId,
            async (s, page) =>
            {
                await s.ActivateAsync(page);
                return await s.StateAsync();
            },
            token,
            requireActive: false
        );

    public Task<BrowserSessionState> ClosePageAsync(string pageId, CancellationToken token) =>
        OnPageAsync(
            pageId,
            async (s, page) =>
            {
                await s.ClosePageAsync(page);
                return await s.StateAsync();
            },
            token,
            requireActive: false
        );

    public Task<PageState> StateAsync(string pageId, CancellationToken token) =>
        OnPageAsync(
            pageId,
            async (s, page) =>
                new PageState(
                    s.Id,
                    page.Id,
                    page.Page.Url,
                    await page.Page.TitleAsync(),
                    s.BlockedPopups,
                    page.DocumentId
                ),
            token,
            requireActive: false
        );

    public Task<PageState> NavigateAsync(string pageId, string url, CancellationToken token)
    {
        if (
            url.Length > 8192
            || !Uri.TryCreate(url, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https")
            || !string.IsNullOrEmpty(uri.UserInfo)
        )
        {
            throw new ApiException(400, "invalid_url", "Enter an HTTP or HTTPS address without embedded credentials.");
        }

        return OnPageAsync(
            pageId,
            async (s, page) =>
            {
                await page.Page.GotoAsync(url, new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 20000 });
                return new PageState(
                    s.Id,
                    page.Id,
                    page.Page.Url,
                    await page.Page.TitleAsync(),
                    s.BlockedPopups,
                    page.DocumentId
                );
            },
            token
        );
    }

    public Task<PageInspection> InspectAsync(string pageId, CancellationToken token) =>
        OnPageAsync(
            pageId,
            async (s, page) =>
            {
                var scrollY = await page.Page.EvaluateAsync<double>("window.scrollY");
                RequireActive(s, page);
                return new PageInspection(
                    s.Id,
                    page.Id,
                    page.Page.Url,
                    await page.Page.TitleAsync(),
                    scrollY,
                    DateTimeOffset.UtcNow
                );
            },
            token
        );

    public Task<CandidateCapture> CaptureAsync(string pageId, CaptureRequest request, CancellationToken token) =>
        OnPageAsync(
            pageId,
            async (s, page) =>
            {
                await RequireFocusedDocumentAsync(s, page, request.DocumentId);
                await page.ClearCaptureAsync();
                await page.BeginCaptureAsync();
                page.CaptureId = Guid.NewGuid().ToString("N");
                var captureId = page.CaptureId;
                page.Capture = new BrowserPageCapture(page);
                var result = await page.Capture.CaptureAsync(s.Id, request.DocumentId, captureId);
                await RequireFocusedDocumentAsync(s, page, request.DocumentId);
                if (page.CaptureId != captureId)
                {
                    throw new ApiException(409, "stale_capture", "This capture is no longer current.");
                }

                return result;
            },
            token
        );

    public Task<SelectionValidation> SelectAsync(string pageId, SelectionRequest request, CancellationToken token)
    {
        RequireAction(request.Action);
        return OnPageAsync(
            pageId,
            async (session, page) =>
            {
                page.ActionSelections = null;
                var result = await ValidateActionsAsync(
                    session,
                    page,
                    request.DocumentId,
                    request.CaptureId,
                    [new ActionSelection("single", request.CandidateId, request.Action)]
                );
                var selection = new SelectionValidation(result.Actions[0].Target);
                await HighlightTargetAsync(
                    session,
                    page,
                    request.DocumentId,
                    request.CaptureId,
                    selection.Target is { } target ? [target] : []
                );
                return selection;
            },
            token
        );
    }

    public Task<ActionSelectionValidation> SelectActionsAsync(
        string pageId,
        ActionSelectionRequest request,
        CancellationToken token
    )
    {
        if (request.Actions.Any(action => action is null))
        {
            throw new ApiException(400, "invalid_request", "Every action must be an object.");
        }
        if (
            request.Actions.Select(action => action.ActionId).Distinct(StringComparer.Ordinal).Count()
            != request.Actions.Length
        )
        {
            throw new ApiException(400, "invalid_actions", "Action identities must be unique.");
        }
        foreach (var action in request.Actions)
        {
            RequireAction(action.Action);
        }
        return OnPageAsync(
            pageId,
            async (session, page) =>
            {
                page.ActionSelections = null;
                var validation = await ValidateActionsAsync(
                    session,
                    page,
                    request.DocumentId,
                    request.CaptureId,
                    request.Actions
                );
                await HighlightTargetAsync(
                    session,
                    page,
                    request.DocumentId,
                    request.CaptureId,
                    validation.Actions.Select(action => action.Target).OfType<ResolvedTarget>().ToArray()
                );
                page.ActionSelections = request.Actions.ToDictionary(action => action.ActionId, StringComparer.Ordinal);
                return validation;
            },
            token
        );
    }

    public Task<ValidatedAction> InspectActionAsync(
        string pageId,
        InspectActionRequest request,
        CancellationToken token
    ) =>
        OnPageAsync(
            pageId,
            async (session, page) =>
            {
                await RequireCaptureAsync(session, page, request.DocumentId, request.CaptureId);
                if (
                    page.ActionSelections is null
                    || !page.ActionSelections.TryGetValue(request.ActionId, out var action)
                    || action.CandidateId is null
                )
                {
                    throw new ApiException(
                        409,
                        "unknown_action",
                        "This action has no verified target in the current capture."
                    );
                }
                var result = await ValidateActionsAsync(session, page, request.DocumentId, request.CaptureId, [action]);
                var selection = new SelectionValidation(result.Actions[0].Target);
                await HighlightTargetAsync(
                    session,
                    page,
                    request.DocumentId,
                    request.CaptureId,
                    selection.Target is { } target ? [target] : []
                );
                return new ValidatedAction(action.ActionId, selection.Target);
            },
            token
        );

    public Task SpotlightAsync(string pageId, SpotlightRequest request, CancellationToken token) =>
        OnPageAsync(
            pageId,
            async (session, page) =>
            {
                await RequireCaptureAsync(session, page, request.DocumentId, request.CaptureId);
                string? candidateId = null;
                if (request.ActionId is { } actionId)
                {
                    if (
                        page.ActionSelections is null
                        || !page.ActionSelections.TryGetValue(actionId, out var action)
                        || action.CandidateId is null
                    )
                    {
                        throw new ApiException(
                            409,
                            "unknown_action",
                            "This action has no verified target in the current capture."
                        );
                    }
                    var validation = await ValidateActionsAsync(
                        session,
                        page,
                        request.DocumentId,
                        request.CaptureId,
                        [action]
                    );
                    candidateId = validation.Actions[0].Target!.CandidateId;
                }
                await page.Capture!.SpotlightAsync(candidateId);
                await RequireCaptureAsync(session, page, request.DocumentId, request.CaptureId);
                return true;
            },
            token
        );

    private static void RequireAction(string action)
    {
        if (
            action
            is not (
                "click"
                or "double_click"
                or "right_click"
                or "hover"
                or "fill"
                or "type"
                or "clear"
                or "select"
                or "check"
                or "uncheck"
                or "press"
                or "focus"
                or "blur"
                or "upload"
                or "inspect"
                or "unsupported"
            )
        )
        {
            throw new ApiException(400, "invalid_action", "The requested action is not supported.");
        }
    }

    private static async Task RequireCaptureAsync(
        BrowserSessionRuntime session,
        BrowserPageRuntime page,
        string documentId,
        string captureId
    )
    {
        await RequireFocusedDocumentAsync(session, page, documentId);
        if (page.Capture is null || page.CaptureId != captureId)
        {
            throw new ApiException(409, "stale_capture", "This capture is no longer current.");
        }
    }

    private static async Task<ActionSelectionValidation> ValidateActionsAsync(
        BrowserSessionRuntime session,
        BrowserPageRuntime page,
        string documentId,
        string captureId,
        ActionSelection[] actions
    )
    {
        await RequireCaptureAsync(session, page, documentId, captureId);
        try
        {
            var result = await page.Capture!.SelectAsync(actions);
            await RequireCaptureAsync(session, page, documentId, captureId);
            return result;
        }
        catch
        {
            await page.ClearHighlightAsync();
            throw;
        }
    }

    private static async Task HighlightTargetAsync(
        BrowserSessionRuntime session,
        BrowserPageRuntime page,
        string documentId,
        string captureId,
        ResolvedTarget[] targets
    )
    {
        await page.ClearHighlightAsync();
        try
        {
            if (targets.Length > 0)
            {
                await page.Capture!.HighlightAsync(targets);
            }
            await RequireCaptureAsync(session, page, documentId, captureId);
        }
        catch
        {
            await page.ClearHighlightAsync();
            throw;
        }
    }

    private static void RequireActive(BrowserSessionRuntime session, BrowserPageRuntime page)
    {
        if (session.ActivePageId != page.Id || session.HasPendingPages)
        {
            throw new ApiException(
                409,
                "inactive_page",
                "The active browser tab changed. Resolve the instruction on the current tab."
            );
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

    private static async Task RequireFocusedDocumentAsync(
        BrowserSessionRuntime session,
        BrowserPageRuntime page,
        string documentId
    )
    {
        RequireDocument(session, page, documentId);
        if (!await page.HasNativeFocusAsync())
        {
            page.InvalidateCapture();
            throw new ApiException(
                409,
                "inactive_page",
                "The active browser tab changed. Resolve the instruction on the current tab."
            );
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
            foreach (
                var session in sessions.Values.Where(s =>
                    s.Stop.IsCancellationRequested || s.LastSeen < DateTimeOffset.UtcNow.AddMinutes(-15)
                )
            )
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
