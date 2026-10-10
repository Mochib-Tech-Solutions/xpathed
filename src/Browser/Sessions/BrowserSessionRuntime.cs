using System.Collections.Concurrent;
using System.Text.Json;
using Xpathed.Browser.Protocol;
using Xpathed.Browser.Viewing;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

internal sealed class BrowserSessionRuntime(
    int slot,
    string browserType,
    BrowserResolution resolution,
    string executable
) : IAsyncDisposable
{
    private ChromiumProcess? browser;
    private readonly ConcurrentDictionary<string, byte> pendingPages = new();
    private long pageOrder;
    private long activationVersion;
    private string activePageId = "";
    private string? pendingFocusId;
    private int blockedPopups;
    private int disposed;
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public int Slot { get; } = slot;
    public string BrowserType { get; } = browserType;
    public BrowserResolution Resolution { get; } = resolution;
    public ConcurrentDictionary<string, BrowserPageRuntime> Pages { get; } = new();
    public string ActivePageId => Volatile.Read(ref activePageId);
    public long ActivationVersion => Interlocked.Read(ref activationVersion);
    public string ViewPath => $"/view/{Id}";
    public bool HasPendingPages => !pendingPages.IsEmpty || Volatile.Read(ref pendingFocusId) is not null;
    public bool Ready { get; private set; }
    public int BlockedPopups => Volatile.Read(ref blockedPopups);
    public DateTimeOffset LastSeen { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? ViewerDisconnectedAt { get; set; }
    public SemaphoreSlim Gate { get; } = new(1);
    public CancellationTokenSource Stop { get; } = new();
    public BrowserViewerRelay? Viewer { get; set; }
    public BrowserViewerInteraction? Interaction { get; set; }

    public bool IsExpired(DateTimeOffset now) =>
        Stop.IsCancellationRequested
        || (ViewerDisconnectedAt is { } disconnected && disconnected <= now.AddMinutes(-1))
        || (Viewer is null && LastSeen <= now.AddMinutes(-15));

    public async Task StartAsync(CancellationToken token)
    {
        browser = new ChromiumProcess();
        await browser.StartAsync(executable, Resolution, token);
        browser.Connection.Disconnected += Disconnected;
        await browser.Connection.SendAsync("Browser.setDownloadBehavior", new { behavior = "deny" });
        var targets = await browser.Connection.SendAsync("Target.getTargets");
        var initial = targets
            .GetProperty("targetInfos")
            .EnumerateArray()
            .First(target => target.GetProperty("type").GetString() == "page");
        await ActivateAsync(await RegisterAsync(initial.GetProperty("targetId").GetString()!));
        browser.Connection.Event += OnEvent;
        await browser.Connection.SendAsync("Target.setDiscoverTargets", new { discover = true });
        Ready = true;
    }

    private void Disconnected() => Stop.Cancel();

    private void OnEvent(string? sessionId, string method, JsonElement data)
    {
        if (sessionId is not null || Stop.IsCancellationRequested)
        {
            return;
        }
        if (method == "Target.targetCreated")
        {
            var info = data.GetProperty("targetInfo");
            var targetId = info.GetProperty("targetId").GetString()!;
            if (
                info.GetProperty("type").GetString() != "page"
                || Pages.Values.Any(page => page.Page.TargetId == targetId)
            )
            {
                return;
            }
            pendingPages.TryAdd(targetId, 0);
            if (Pages.TryGetValue(ActivePageId, out var active))
            {
                active.InvalidateCapture();
            }
            _ = UpdatePagesAsync();
        }
        else if (method == "Target.targetDestroyed")
        {
            var targetId = data.GetProperty("targetId").GetString()!;
            pendingPages.TryRemove(targetId, out _);
            var page = Pages.Values.FirstOrDefault(page => page.Page.TargetId == targetId);
            if (page is not null)
            {
                page.Page.MarkClosed();
                page.InvalidateCapture();
                _ = UpdatePagesAsync();
            }
        }
    }

    private async Task<BrowserPageRuntime> RegisterAsync(string targetId)
    {
        var existing = Pages.Values.FirstOrDefault(page => page.Page.TargetId == targetId);
        if (existing is not null)
        {
            pendingPages.TryRemove(targetId, out _);
            return existing;
        }
        var attached = await browser!.Connection.SendAsync("Target.attachToTarget", new { targetId, flatten = true });
        var page = new BrowserPageRuntime(
            new CdpPage(browser.Connection, targetId, attached.GetProperty("sessionId").GetString()!, Resolution),
            ++pageOrder
        );
        await page.InitializeAsync();
        Pages[page.Id] = page;
        page.Page.ScreencastFrame += frame =>
        {
            if (ActivePageId == page.Id)
            {
                Viewer?.Publish(
                    new(
                        page.Id,
                        page.DocumentId,
                        Resolution.Width,
                        Resolution.Height,
                        frame.GetProperty("data").GetString()!
                    )
                );
            }
        };
        page.Page.DialogChanged += dialog => Interaction?.DialogChanged(page, dialog);
        page.Page.CursorChanged += cursor =>
        {
            if (ActivePageId == page.Id)
            {
                Viewer?.PublishCursor(
                    new
                    {
                        type = "cursor",
                        pageId = page.Id,
                        documentId = page.DocumentId,
                        cursor,
                    }
                );
            }
        };
        page.Page.Focused += () =>
        {
            if (!Ready || Stop.IsCancellationRequested || ActivePageId == page.Id)
            {
                return;
            }
            Volatile.Write(ref pendingFocusId, page.Id);
            if (Pages.TryGetValue(ActivePageId, out var previous))
            {
                previous.InvalidateCapture();
            }
            _ = UpdatePagesAsync();
        };
        page.Invalidated += () => Interaction?.Invalidated(page);
        pendingPages.TryRemove(targetId, out _);
        return page;
    }

    public async Task<BrowserPageRuntime> NewPageAsync()
    {
        if (Pages.Count >= 8)
        {
            throw new ApiException(409, "tab_limit", "Close a tab before opening another (limit 8).");
        }
        var created = await browser!.Connection.SendAsync("Target.createTarget", new { url = "about:blank" });
        var page = await RegisterAsync(created.GetProperty("targetId").GetString()!);
        await ActivateAsync(page);
        return page;
    }

    public async Task ActivateAsync(BrowserPageRuntime page)
    {
        if (ActivePageId != page.Id && Pages.TryGetValue(ActivePageId, out var previous))
        {
            if (Interaction is not null)
            {
                await Interaction.ReleaseAsync(previous);
            }
            await previous.ClearCaptureAsync();
            if (!previous.Page.IsClosed)
            {
                await previous.Page.StopScreencastAsync();
                await previous.Page.SendAsync("Emulation.setFocusEmulationEnabled", new { enabled = false });
                if (previous.Page.WindowId != page.Page.WindowId)
                {
                    await previous.Page.MinimizeAsync();
                }
            }
        }
        await page.ShowAsync();
        if (Interlocked.Exchange(ref activePageId, page.Id) != page.Id)
        {
            Interlocked.Increment(ref activationVersion);
        }
        await page.Page.SendAsync("Emulation.setFocusEmulationEnabled", new { enabled = true });
        if (Viewer is not null)
        {
            await page.Page.StartScreencastAsync();
            if (Interaction is not null)
            {
                await Interaction.ReplayAsync(page);
            }
        }
    }

    public async Task ClosePageAsync(BrowserPageRuntime page)
    {
        var ordered = Pages
            .Values.Where(other => other.Id != page.Id && !other.Page.IsClosed)
            .OrderBy(other => other.Order)
            .ToArray();
        if (Interaction is not null)
        {
            await Interaction.ReleaseAsync(page);
        }
        Pages.TryRemove(page.Id, out _);
        await page.ClearCaptureAsync();
        if (ordered.Length == 0)
        {
            await NewPageAsync();
        }
        else if (ActivePageId == page.Id)
        {
            await ActivateAsync(ordered.FirstOrDefault(other => other.Order > page.Order) ?? ordered[^1]);
        }
        if (!page.Page.IsClosed)
        {
            await page.Page.CloseAsync();
        }
    }

    private async Task RefreshPagesAsync()
    {
        var focused = Volatile.Read(ref pendingFocusId);
        if (focused is not null)
        {
            if (Pages.TryGetValue(focused, out var page) && !page.Page.IsClosed)
            {
                await ActivateAsync(page);
            }
            Interlocked.CompareExchange(ref pendingFocusId, null, focused);
        }
        foreach (var id in pendingPages.Keys)
        {
            try
            {
                if (Pages.Values.Any(page => page.Page.TargetId == id))
                {
                    continue;
                }
                if (Pages.Count >= 8)
                {
                    Interlocked.Increment(ref blockedPopups);
                    await browser!.Connection.SendAsync("Target.closeTarget", new { targetId = id });
                }
                else
                {
                    await ActivateAsync(await RegisterAsync(id));
                }
            }
            finally
            {
                pendingPages.TryRemove(id, out _);
            }
        }
        foreach (var page in Pages.Values.Where(page => page.Page.IsClosed).ToArray())
        {
            await ClosePageAsync(page);
        }
    }

    private async Task UpdatePagesAsync()
    {
        try
        {
            await Gate.WaitAsync(Stop.Token);
            try
            {
                await RefreshPagesAsync();
            }
            finally
            {
                Gate.Release();
            }
        }
        catch (OperationCanceledException) when (Stop.IsCancellationRequested) { }
        catch (CdpException)
        {
            await Stop.CancelAsync();
        }
    }

    public async Task<BrowserSessionState> StateAsync()
    {
        await RefreshPagesAsync();
        var pages = new List<PageState>();
        foreach (var page in Pages.Values.OrderBy(page => page.Order))
        {
            if (!page.Page.IsClosed)
            {
                pages.Add(new(Id, page.Id, page.Page.Url, page.Page.Title, BlockedPopups, page.DocumentId));
            }
        }
        return new(Id, ActivePageId, ViewPath, pages.ToArray(), ActivationVersion, BrowserType, Resolution.Id);
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0)
        {
            return;
        }
        Ready = false;
        await Stop.CancelAsync();
        if (browser is not null)
        {
            browser.Connection.Event -= OnEvent;
            browser.Connection.Disconnected -= Disconnected;
            foreach (var page in Pages.Values)
            {
                page.Page.MarkClosed();
            }
            await browser.DisposeAsync();
        }
    }
}
