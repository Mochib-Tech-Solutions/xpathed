using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net.Sockets;
using Microsoft.Playwright;
using Xpathed;

internal sealed partial class BrowserSessions(IConfiguration configuration, ILogger<BrowserSessions> logger) : IAsyncDisposable
{
    private readonly ConcurrentDictionary<string, Session> sessions = new();
    private readonly SemaphoreSlim creation = new(1);
    private readonly int capacity = Math.Clamp(configuration.GetValue("MaxSessions", 4), 1, 16);

    public async Task<BrowserSession> Create(CancellationToken token)
    {
        await creation.WaitAsync(token);
        Session? session = null;
        try
        {
            var slot = Enumerable.Range(0, capacity).FirstOrDefault(i => sessions.Values.All(s => s.Slot != i), -1);
            if (slot < 0)
            {
                throw new ApiException(409, "session_limit", $"Close a session before opening another (limit {capacity}).");
            }

            session = new Session(slot);
            sessions[session.Id] = session;
            await session.Gate.WaitAsync(token);
            try
            {
                session.Display = Start("Xvfb", $":{session.DisplayNumber}", "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac");
                await WaitUntil(() => File.Exists($"/tmp/.X11-unix/X{session.DisplayNumber}"), token);
                session.Playwright = await Playwright.CreateAsync();
                session.Browser = await session.Playwright.Chromium.LaunchAsync(new()
                {
                    Headless = false,
                    ChromiumSandbox = true,
                    Env = new Dictionary<string, string> { ["DISPLAY"] = $":{session.DisplayNumber}" },
                    Args = ["--kiosk", "--window-position=0,0", "--window-size=1280,800"],
                    Timeout = 20000
                });
                session.Context = await session.Browser.NewContextAsync(new()
                {
                    ViewportSize = new() { Width = 1280, Height = 800 },
                    AcceptDownloads = false
                });
                session.Page = await session.Context.NewPageAsync();
                var displayControl = await session.Context.NewCDPSessionAsync(session.Page);
                var window = await displayControl.SendAsync("Browser.getWindowForTarget");
                await displayControl.SendAsync("Browser.setWindowBounds", new Dictionary<string, object>
                {
                    ["windowId"] = window!.Value.GetProperty("windowId").GetInt32(),
                    ["bounds"] = new { windowState = "fullscreen" }
                });
                await displayControl.DetachAsync();
                session.Context.Page += async (_, popup) =>
                {
                    if (popup == session.Page)
                    {
                        return;
                    }

                    Interlocked.Increment(ref session.BlockedPopups);
                    try
                    {
                        await popup.CloseAsync();
                    }
                    catch (PlaywrightException) { }
                };
                session.Page.Close += (_, _) => session.Stop.Cancel();
                session.Browser.Disconnected += (_, _) => session.Stop.Cancel();
                session.Page.SetDefaultTimeout(10000);
                session.Vnc = Start("x11vnc", "-display", $":{session.DisplayNumber}", "-rfbport", session.Port.ToString(CultureInfo.InvariantCulture),
                    "-localhost", "-forever", "-shared", "-nopw", "-quiet", "-xkb");
                await WaitUntil(async () =>
                {
                    try
                    {
                        using var tcp = new TcpClient();
                        await tcp.ConnectAsync("127.0.0.1", session.Port, token);
                        return true;
                    }
                    catch (SocketException)
                    {
                        return false;
                    }
                }, token);
                token.ThrowIfCancellationRequested();
                session.Ready = true;
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
                await Close(session.Id);
            }

            throw;
        }
        finally
        {
            creation.Release();
        }
    }

    public Session Find(string pageId)
    {
        var session = sessions.Values.FirstOrDefault(s => s.PageId == pageId && s.Ready && !s.Stop.IsCancellationRequested);
        if (session is null)
        {
            throw new ApiException(404, "page_not_found", "This page is closed or no longer available. Start a fresh session.");
        }

        session.LastSeen = DateTimeOffset.UtcNow;
        return session;
    }

    public async Task<T> OnPage<T>(string pageId, Func<Session, Task<T>> operation, CancellationToken token)
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

    public Task<PageState> State(string pageId, CancellationToken token) => OnPage(pageId, async s =>
        new PageState(s.Id, s.PageId, s.Page!.Url, await s.Page.TitleAsync(), s.BlockedPopups), token);

    public Task<PageState> Navigate(string pageId, string url, CancellationToken token)
    {
        if (url.Length > 8192 || !Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(uri.UserInfo))
        {
            throw new ApiException(400, "invalid_url", "Enter an HTTP or HTTPS address without embedded credentials.");
        }

        return OnPage(pageId, async s =>
        {
            await s.Page!.GotoAsync(url, new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 20000 });
            return new PageState(s.Id, s.PageId, s.Page.Url, await s.Page.TitleAsync(), s.BlockedPopups);
        }, token);
    }

    public Task<PageInspection> Inspect(string pageId, CancellationToken token) => OnPage(pageId, async s =>
    {
        var scrollY = await s.Page!.EvaluateAsync<double>("window.scrollY");
        return new PageInspection(s.Id, s.PageId, s.Page.Url, await s.Page.TitleAsync(), scrollY, DateTimeOffset.UtcNow);
    }, token);

    public async Task Close(string sessionId)
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

    public async Task Reap(CancellationToken token)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
        while (await timer.WaitForNextTickAsync(token))
        {
            foreach (var session in sessions.Values.Where(s => s.Stop.IsCancellationRequested || s.LastSeen < DateTimeOffset.UtcNow.AddMinutes(-15)))
            {
                await Close(session.Id);
            }
        }
    }

    private Process Start(string name, params string[] args)
    {
        var info = new ProcessStartInfo(name) { RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in args)
        {
            info.ArgumentList.Add(arg);
        }

        var process = Process.Start(info) ?? throw new InvalidOperationException($"Could not start {name}.");
        // Drain display logs without collecting visited page data.
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        process.EnableRaisingEvents = true;
        process.Exited += (_, _) => DisplayExited(logger, name);
        return process;
    }

    private static Task WaitUntil(Func<bool> ready, CancellationToken token) => WaitUntil(() => Task.FromResult(ready()), token);
    private static async Task WaitUntil(Func<Task<bool>> ready, CancellationToken token)
    {
        for (var i = 0; i < 100; i++)
        {
            if (await ready())
            {
                return;
            }

            await Task.Delay(50, token);
        }
        throw new ApiException(503, "display_unavailable", "The browser display could not start.");
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var id in sessions.Keys)
        {
            await Close(id);
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Display process {Process} exited")]
    static partial void DisplayExited(ILogger logger, string process);

}

internal sealed class Session(int slot) : IAsyncDisposable
{
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public string PageId { get; } = Guid.NewGuid().ToString("N");
    public int Slot { get; } = slot;
    public int DisplayNumber => 100 + Slot;
    public int Port => 5900 + Slot;
    public bool Ready { get; set; }
    public DateTimeOffset LastSeen { get; set; } = DateTimeOffset.UtcNow;
    public int BlockedPopups;
    public CancellationTokenSource Stop { get; } = new();
    public SemaphoreSlim Gate { get; } = new(1);
    public IPlaywright? Playwright { get; set; }
    public IBrowser? Browser { get; set; }
    public IBrowserContext? Context { get; set; }
    public IPage? Page { get; set; }
    public Process? Display { get; set; }
    public Process? Vnc { get; set; }

    public async ValueTask DisposeAsync()
    {
        Ready = false;
        await Stop.CancelAsync();
        if (Browser is not null)
        {
            try
            {
                await Browser.CloseAsync();
            }
            catch (PlaywrightException) { }
            Browser = null;
        }
        Playwright?.Dispose();
        Playwright = null;
        foreach (var process in new[] { Vnc, Display })
        {
            if (process is null)
            {
                continue;
            }

            if (!process.HasExited)
            {
                process.Kill(true);
                await process.WaitForExitAsync();
            }
            process.Dispose();
        }
        Vnc = null;
        Display = null;
    }
}
