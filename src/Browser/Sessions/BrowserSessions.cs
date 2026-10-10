using System.Collections.Concurrent;
using System.Net.WebSockets;
using Xpathed.Browser.Protocol;
using Xpathed.Browser.Viewing;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

public sealed partial class BrowserSessions(IConfiguration configuration) : IAsyncDisposable
{
    private readonly ConcurrentDictionary<string, BrowserSessionRuntime> sessions = new();
    private readonly SemaphoreSlim creation = new(1);
    private readonly int capacity = Math.Clamp(configuration.GetValue("MaxSessions", 4), 1, 16);

    private readonly string defaultBrowserType = ValidateBrowserType(configuration["DefaultBrowserType"] ?? "chromium");

    private static readonly BrowserResolution[] Resolutions =
    [
        new("1024x768", 1024, 768),
        new("1280x800", 1280, 800),
        new("1366x768", 1366, 768),
        new("1440x900", 1440, 900),
        new("1920x1080", 1920, 1080),
    ];

    public BrowserSessionOptions Options => new(defaultBrowserType, ["chromium"], "1280x800", Resolutions);

    private static string ValidateBrowserType(string browserType) =>
        browserType is "chromium"
            ? browserType
            : throw new ApiException(400, "invalid_browser_type", "Choose Chromium.");

    public async Task<BrowserSession> CreateAsync(string? browserType, string? resolutionId, CancellationToken token)
    {
        browserType = ValidateBrowserType(browserType ?? defaultBrowserType);
        var resolution =
            Resolutions.FirstOrDefault(choice => choice.Id == (resolutionId ?? "1280x800"))
            ?? throw new ApiException(400, "invalid_resolution", "Choose a supported browser resolution.");
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

            session = new BrowserSessionRuntime(
                slot,
                browserType,
                resolution,
                configuration["BrowserExecutablePath"] ?? ""
            );
            sessions[session.Id] = session;
            await session.Gate.WaitAsync(token);
            try
            {
                await session.StartAsync(token);
                return new(
                    session.Id,
                    session.ActivePageId,
                    session.ViewPath,
                    session.BrowserType,
                    session.Resolution.Id
                );
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
        CancellationToken token,
        bool recordActivity = true
    )
    {
        if (recordActivity)
        {
            session.LastSeen = DateTimeOffset.UtcNow;
        }
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
            catch (CdpDialogPendingException)
            {
                throw new ApiException(409, "dialog_pending", "Answer the browser dialog first.");
            }
            catch (CdpException)
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
        OnSessionAsync(FindSession(sessionId), s => s.StateAsync(), token, recordActivity: false);

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
            (s, page) =>
                Task.FromResult(
                    new PageState(s.Id, page.Id, page.Page.Url, page.Page.Title, s.BlockedPopups, page.DocumentId)
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
                await page.Page.NavigateAsync(url);
                return new PageState(s.Id, page.Id, page.Page.Url, page.Page.Title, s.BlockedPopups, page.DocumentId);
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
                    page.Page.Title,
                    scrollY,
                    DateTimeOffset.UtcNow
                );
            },
            token
        );

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
        if (page.Page.CurrentDialog is not null)
        {
            throw new ApiException(409, "dialog_pending", "Answer the browser dialog first.");
        }
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
        await session.Gate.WaitAsync(CancellationToken.None);
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
            foreach (var session in sessions.Values.Where(s => s.IsExpired(DateTimeOffset.UtcNow)))
            {
                await session.Gate.WaitAsync(token);
                try
                {
                    // Recheck under the viewer's gate so a successful reconnect wins.
                    if (session.IsExpired(DateTimeOffset.UtcNow))
                    {
                        await session.DisposeAsync();
                        sessions.TryRemove(session.Id, out _);
                    }
                }
                finally
                {
                    session.Gate.Release();
                }
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
