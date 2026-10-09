using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net.Sockets;
using Microsoft.Playwright;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

internal sealed partial class BrowserSessionRuntime(int slot, string browserType, ILogger logger) : IAsyncDisposable
{
    private int blockedPopups;
    private long pageOrder;
    private string activePageId = "";
    private long activationVersion;
    private long focusRevision;
    private long synchronizedFocusRevision;
    private readonly ConcurrentDictionary<IPage, byte> pendingPages = new();

    public string Id { get; } = Guid.NewGuid().ToString("N");
    public ConcurrentDictionary<string, BrowserPageRuntime> Pages { get; } = new();
    public string ActivePageId => Volatile.Read(ref activePageId);
    public long ActivationVersion => Interlocked.Read(ref activationVersion);
    public string ViewPath => $"/view/{Id}";
    public bool HasPendingPages =>
        !pendingPages.IsEmpty || Interlocked.Read(ref focusRevision) != Interlocked.Read(ref synchronizedFocusRevision);
    public int Slot { get; } = slot;
    public string BrowserType { get; } = browserType;
    private int DisplayNumber => 100 + Slot;
    public int Port => 5900 + Slot;
    public bool Ready { get; private set; }
    public int BlockedPopups => Volatile.Read(ref blockedPopups);
    public DateTimeOffset LastSeen { get; set; } = DateTimeOffset.UtcNow;
    public SemaphoreSlim Gate { get; } = new(1);
    public CancellationTokenSource Stop { get; } = new();
    private IPlaywright? Playwright { get; set; }
    private IBrowser? Browser { get; set; }
    private IBrowserContext? Context { get; set; }
    private Process? Display { get; set; }
    private Process? WindowManager { get; set; }
    private Process? Vnc { get; set; }
    private FirefoxDisplay? firefoxDisplay;
    private string? firefoxProfile;
    private Task? firefoxFocusMonitor;

    public async Task StartAsync(CancellationToken token)
    {
        Display = Start("Xvfb", $":{DisplayNumber}", "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac");
        await WaitUntilAsync(() => File.Exists($"/tmp/.X11-unix/X{DisplayNumber}"), token);
        Playwright = await Microsoft.Playwright.Playwright.CreateAsync();
        if (BrowserType == "firefox")
        {
            WindowManager = Start("matchbox-window-manager", "-display", $":{DisplayNumber}", "-use_titlebar", "no");
            firefoxDisplay = new FirefoxDisplay($":{DisplayNumber}");
            firefoxProfile = Directory.CreateTempSubdirectory("xpathed-firefox-").FullName;
            Directory.CreateDirectory(Path.Combine(firefoxProfile, "chrome"));
            // This startup preference must precede Firefox's first window; launch preferences arrive later.
            await File.WriteAllTextAsync(
                Path.Combine(firefoxProfile, "user.js"),
                "user_pref(\"toolkit.legacyUserProfileCustomizations.stylesheets\", true);",
                token
            );
            await File.WriteAllTextAsync(
                Path.Combine(firefoxProfile, "chrome", "userChrome.css"),
                "#navigator-toolbox, #titlebar, #sidebar-main, #sidebar-box, #statuspanel { visibility: collapse !important; min-height: 0 !important; height: 0 !important; }",
                token
            );
            Context = await Playwright.Firefox.LaunchPersistentContextAsync(
                firefoxProfile,
                new()
                {
                    Headless = false,
                    ViewportSize = ViewportSize.NoViewport,
                    AcceptDownloads = false,
                    Env = new Dictionary<string, string> { ["DISPLAY"] = $":{DisplayNumber}" },
                    FirefoxUserPrefs = new Dictionary<string, object>
                    {
                        ["dom.disable_window_move_resize"] = true,
                        ["focusmanager.testmode"] = false,
                        ["browser.link.open_newwindow"] = 2,
                        ["browser.link.open_newwindow.restriction"] = 0,
                    },
                    Timeout = 20000,
                }
            );
            Browser = Context.Browser!;
        }
        else
        {
            Browser = await Playwright.Chromium.LaunchAsync(
                new()
                {
                    Headless = false,
                    ChromiumSandbox = true,
                    Env = new Dictionary<string, string> { ["DISPLAY"] = $":{DisplayNumber}" },
                    Args = ["--kiosk", "--window-position=0,0", "--window-size=1280,800"],
                    Timeout = 20000,
                }
            );
            Context = await Browser.NewContextAsync(
                new() { ViewportSize = ViewportSize.NoViewport, AcceptDownloads = false }
            );
        }
        var initialPage = await Context.NewPageAsync();
        foreach (var startupPage in Context.Pages.Where(page => page != initialPage).ToArray())
        {
            await startupPage.CloseAsync();
        }
        await ActivateAsync(await RegisterAsync(initialPage));
        Context.Page += (_, page) =>
        {
            pendingPages.TryAdd(page, 0);
            if (Pages.TryGetValue(ActivePageId, out var active))
            {
                active.InvalidateCapture();
            }

            _ = AcceptPageAsync(page);
        };
        Browser.Disconnected += (_, _) => Stop.Cancel();
        Vnc = Start(
            "x11vnc",
            "-display",
            $":{DisplayNumber}",
            "-rfbport",
            Port.ToString(CultureInfo.InvariantCulture),
            "-localhost",
            "-forever",
            "-shared",
            "-nopw",
            "-quiet",
            "-xkb"
        );
        await WaitUntilAsync(
            async () =>
            {
                try
                {
                    using var tcp = new TcpClient();
                    await tcp.ConnectAsync("127.0.0.1", Port, token);
                    return true;
                }
                catch (SocketException)
                {
                    return false;
                }
            },
            token
        );
        token.ThrowIfCancellationRequested();
        firefoxDisplay?.ReadFocusChanges();
        Ready = true;
        if (firefoxDisplay is not null)
        {
            firefoxFocusMonitor = MonitorFirefoxFocusAsync();
        }
    }

    private async Task<BrowserPageRuntime> RegisterAsync(IPage page)
    {
        var existing = Pages.Values.FirstOrDefault(p => p.Page == page);
        if (existing is not null)
        {
            return existing;
        }

        var managed = new BrowserPageRuntime(
            page,
            ++pageOrder,
            firefoxDisplay is null ? new ChromiumPageDisplay(page) : new FirefoxPageDisplay(page)
        );
        await managed.InitializeAsync(Context!, NativeFocusChanged);
        Pages[managed.Id] = managed;
        pendingPages.TryRemove(page, out _);
        page.Close += (_, _) =>
        {
            managed.InvalidateCapture();
            _ = RemoveClosedPageAsync(managed);
        };
        return managed;
    }

    public async Task<BrowserPageRuntime> NewPageAsync()
    {
        if (Pages.Count >= 8)
        {
            throw new ApiException(409, "tab_limit", "Close a tab before opening another (limit 8).");
        }
        var page = await RegisterAsync(await Context!.NewPageAsync());
        await ActivateAsync(page);
        return page;
    }

    public async Task ActivateAsync(BrowserPageRuntime page)
    {
        if (ActivePageId != page.Id && Pages.TryGetValue(ActivePageId, out var previous))
        {
            await previous.ClearCaptureAsync();
        }
        await page.ShowAsync();
        SetActive(page);
    }

    private void SetActive(BrowserPageRuntime page)
    {
        var previous = Interlocked.Exchange(ref activePageId, page.Id);
        if (previous != page.Id)
        {
            Interlocked.Increment(ref activationVersion);
            if (Pages.TryGetValue(previous, out var oldPage))
            {
                oldPage.InvalidateCapture();
            }
        }
    }

    private void NativeFocusChanged(BrowserPageRuntime page)
    {
        if (!Ready || Stop.IsCancellationRequested || !Pages.ContainsKey(page.Id) || ActivePageId == page.Id)
        {
            return;
        }

        SetActive(page);
        Interlocked.Increment(ref focusRevision);
        _ = SynchronizeNativeFocusAsync();
    }

    public void ObserveNativeFocus()
    {
        if (firefoxDisplay is null || !firefoxDisplay.ReadFocusChanges())
        {
            return;
        }
        foreach (var page in Pages.Values)
        {
            page.InvalidateCapture();
        }
        Interlocked.Increment(ref focusRevision);
        _ = SynchronizeNativeFocusAsync();
    }

    private async Task MonitorFirefoxFocusAsync()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(10));
        try
        {
            while (await timer.WaitForNextTickAsync(Stop.Token))
            {
                ObserveNativeFocus();
            }
        }
        catch (OperationCanceledException) when (Stop.IsCancellationRequested) { }
        catch (PlaywrightException)
        {
            await Stop.CancelAsync();
        }
    }

    private async Task SynchronizeNativeFocusAsync()
    {
        try
        {
            await Gate.WaitAsync(Stop.Token);
            try
            {
                await RefreshFocusAsync();
            }
            finally
            {
                Gate.Release();
            }
        }
        catch (OperationCanceledException) when (Stop.IsCancellationRequested) { }
        catch (PlaywrightException)
        {
            await Stop.CancelAsync();
        }
    }

    private async Task RefreshFocusAsync()
    {
        var revision = Interlocked.Read(ref focusRevision);
        if (revision == Interlocked.Read(ref synchronizedFocusRevision))
        {
            return;
        }

        // Separate Chromium windows can both report focus; prefer the latest notification.
        var focusedPageId = ActivePageId;
        foreach (var page in Pages.Values.OrderByDescending(page => page.Id == focusedPageId))
        {
            if (!page.Page.IsClosed && await page.HasNativeFocusAsync())
            {
                foreach (var other in Pages.Values.Where(p => p.Id != page.Id))
                {
                    await other.ClearCaptureAsync();
                }

                if (revision != Interlocked.Read(ref focusRevision))
                {
                    return;
                }
                SetActive(page);
                break;
            }
        }
        Interlocked.Exchange(ref synchronizedFocusRevision, revision);
    }

    public async Task ClosePageAsync(BrowserPageRuntime page)
    {
        var ordered = Pages.Values.Where(p => p.Id != page.Id && !p.Page.IsClosed).OrderBy(p => p.Order).ToArray();
        Pages.TryRemove(page.Id, out _);
        await page.ClearCaptureAsync();
        if (ordered.Length == 0)
        {
            await NewPageAsync();
        }
        else if (ActivePageId == page.Id)
        {
            await ActivateAsync(ordered.FirstOrDefault(p => p.Order > page.Order) ?? ordered[^1]);
        }
        if (!page.Page.IsClosed)
        {
            await page.Page.CloseAsync();
        }
    }

    public async Task<BrowserSessionState> StateAsync()
    {
        for (var attempt = 0; attempt < 8; attempt++)
        {
            foreach (var page in pendingPages.Keys)
            {
                await AdoptPageAsync(page);
            }
            foreach (var page in Pages.Values.Where(p => p.Page.IsClosed).ToArray())
            {
                await ClosePageAsync(page);
            }
            ObserveNativeFocus();
            await RefreshFocusAsync();
            var pages = new List<PageState>();
            foreach (var page in Pages.Values.OrderBy(p => p.Order))
            {
                if (!page.Page.IsClosed)
                {
                    pages.Add(
                        new(Id, page.Id, page.Page.Url, await page.Page.TitleAsync(), BlockedPopups, page.DocumentId)
                    );
                }
            }
            if (!HasPendingPages && pages.Any(page => page.PageId == ActivePageId))
            {
                return new(Id, ActivePageId, ViewPath, pages.ToArray(), ActivationVersion, BrowserType);
            }
        }
        throw new ApiException(409, "inactive_page", "The active browser tab is changing. Try again.");
    }

    private async Task AcceptPageAsync(IPage page)
    {
        try
        {
            await Gate.WaitAsync(Stop.Token);
            try
            {
                await AdoptPageAsync(page);
            }
            finally
            {
                Gate.Release();
            }
        }
        catch (OperationCanceledException) when (Stop.IsCancellationRequested) { }
        finally
        {
            pendingPages.TryRemove(page, out _);
        }
    }

    private async Task AdoptPageAsync(IPage page)
    {
        try
        {
            if (Stop.IsCancellationRequested || page.IsClosed || Pages.Values.Any(p => p.Page == page))
            {
                return;
            }

            if (Pages.Count >= 8)
            {
                Interlocked.Increment(ref blockedPopups);
                await page.CloseAsync();
                if (Pages.TryGetValue(ActivePageId, out var active))
                {
                    await active.ShowAsync();
                }

                return;
            }
            await ActivateAsync(await RegisterAsync(page));
        }
        catch (PlaywrightException)
        {
            try
            {
                var failed = Pages.Values.FirstOrDefault(p => p.Page == page);
                if (failed is not null)
                {
                    await ClosePageAsync(failed);
                }
                else if (!page.IsClosed)
                {
                    await page.CloseAsync();
                }
                if (Pages.TryGetValue(ActivePageId, out var active) && !active.Page.IsClosed)
                {
                    await active.ShowAsync();
                }
                else
                {
                    await NewPageAsync();
                }
            }
            catch (PlaywrightException)
            {
                await Stop.CancelAsync();
            }
        }
        finally
        {
            pendingPages.TryRemove(page, out _);
        }
    }

    private async Task RemoveClosedPageAsync(BrowserPageRuntime page)
    {
        try
        {
            await Gate.WaitAsync(Stop.Token);
            try
            {
                if (!Stop.IsCancellationRequested && Pages.ContainsKey(page.Id))
                {
                    await ClosePageAsync(page);
                }
            }
            finally
            {
                Gate.Release();
            }
        }
        catch (OperationCanceledException) when (Stop.IsCancellationRequested) { }
        catch (PlaywrightException)
        {
            await Stop.CancelAsync();
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

    private static Task WaitUntilAsync(Func<bool> ready, CancellationToken token) =>
        WaitUntilAsync(() => Task.FromResult(ready()), token);

    private static async Task WaitUntilAsync(Func<Task<bool>> ready, CancellationToken token)
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
        Ready = false;
        await Stop.CancelAsync();
        if (firefoxFocusMonitor is not null)
        {
            await firefoxFocusMonitor;
        }
        firefoxDisplay?.Dispose();
        firefoxDisplay = null;
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
        if (firefoxProfile is not null && Directory.Exists(firefoxProfile))
        {
            Directory.Delete(firefoxProfile, true);
        }
        firefoxProfile = null;
        foreach (var process in new[] { Vnc, WindowManager, Display })
        {
            if (process is null)
            {
                continue;
            }

            if (!process.HasExited)
            {
                // x11vnc must detach and remove its System V shared-memory segments before Xvfb exits.
                using var signal = Process.Start(
                    new ProcessStartInfo("/bin/kill")
                    {
                        ArgumentList = { "-TERM", process.Id.ToString(CultureInfo.InvariantCulture) },
                        RedirectStandardError = true,
                    }
                );
                if (signal is not null)
                {
                    await signal.WaitForExitAsync();
                }
                try
                {
                    await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(2));
                }
                catch (TimeoutException)
                {
                    try
                    {
                        if (!process.HasExited)
                        {
                            process.Kill(true);
                        }
                    }
                    catch (InvalidOperationException) when (process.HasExited) { }
                    await process.WaitForExitAsync();
                }
            }
            process.Dispose();
        }
        Vnc = null;
        Display = null;
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Display process {Process} exited")]
    private static partial void DisplayExited(ILogger logger, string process);
}
