using System.Collections.Concurrent;
using Microsoft.Playwright;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

internal sealed class BrowserSessions(IConfiguration configuration, ILogger<BrowserSessions> logger) : IAsyncDisposable
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

    public BrowserSessionRuntime Find(string pageId)
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
        new PageState(s.Id, s.PageId, s.Page!.Url, await s.Page.TitleAsync(), s.BlockedPopups), token);

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
            return new PageState(s.Id, s.PageId, s.Page.Url, await s.Page.TitleAsync(), s.BlockedPopups);
        }, token);
    }

    public Task<PageInspection> InspectAsync(string pageId, CancellationToken token) => OnPageAsync(pageId, async s =>
    {
        var scrollY = await s.Page!.EvaluateAsync<double>("window.scrollY");
        return new PageInspection(s.Id, s.PageId, s.Page.Url, await s.Page.TitleAsync(), scrollY, DateTimeOffset.UtcNow);
    }, token);

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
