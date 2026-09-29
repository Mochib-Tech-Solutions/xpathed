using System.Diagnostics;
using System.Globalization;
using System.Net.Sockets;
using Microsoft.Playwright;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

internal sealed partial class BrowserSessionRuntime(int slot, ILogger logger) : IAsyncDisposable
{
    private int blockedPopups;

    public string Id { get; } = Guid.NewGuid().ToString("N");
    public string PageId { get; } = Guid.NewGuid().ToString("N");
    public string DocumentId { get; private set; } = Guid.NewGuid().ToString("N");
    public string? CaptureId { get; set; }
    public IJSHandle? Capture { get; set; }
    public ICDPSession? Highlight { get; private set; }
    public int Slot { get; } = slot;
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
    public IPage? Page { get; private set; }
    private Process? Display { get; set; }
    private Process? Vnc { get; set; }

    public async Task StartAsync(CancellationToken token)
    {
        Display = Start("Xvfb", $":{DisplayNumber}", "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac");
        await WaitUntilAsync(() => File.Exists($"/tmp/.X11-unix/X{DisplayNumber}"), token);
        Playwright = await Microsoft.Playwright.Playwright.CreateAsync();
        Browser = await Playwright.Chromium.LaunchAsync(new()
        {
            Headless = false,
            ChromiumSandbox = true,
            Env = new Dictionary<string, string> { ["DISPLAY"] = $":{DisplayNumber}" },
            Args = ["--kiosk", "--window-position=0,0", "--window-size=1280,800"],
            Timeout = 20000
        });
        Context = await Browser.NewContextAsync(new()
        {
            ViewportSize = new() { Width = 1280, Height = 800 },
            AcceptDownloads = false
        });
        Page = await Context.NewPageAsync();
        Page.FrameNavigated += (_, frame) =>
        {
            if (frame == Page.MainFrame)
            {
                DocumentId = Guid.NewGuid().ToString("N");
                CaptureId = null;
                _ = ClearNavigationHighlightAsync();
            }
        };
        var displayControl = await Context.NewCDPSessionAsync(Page);
        var window = await displayControl.SendAsync("Browser.getWindowForTarget");
        await displayControl.SendAsync("Browser.setWindowBounds", new Dictionary<string, object>
        {
            ["windowId"] = window!.Value.GetProperty("windowId").GetInt32(),
            ["bounds"] = new { windowState = "fullscreen" }
        });
        await displayControl.SendAsync("DOM.enable");
        await displayControl.SendAsync("Overlay.enable");
        Highlight = displayControl;
        Context.Page += async (_, popup) =>
        {
            if (popup == Page)
            {
                return;
            }

            Interlocked.Increment(ref blockedPopups);
            try
            {
                await popup.CloseAsync();
            }
            catch (PlaywrightException) { }
        };
        Page.Close += (_, _) => Stop.Cancel();
        Browser.Disconnected += (_, _) => Stop.Cancel();
        Page.SetDefaultTimeout(10000);
        Vnc = Start("x11vnc", "-display", $":{DisplayNumber}", "-rfbport", Port.ToString(CultureInfo.InvariantCulture),
            "-localhost", "-forever", "-shared", "-nopw", "-quiet", "-xkb");
        await WaitUntilAsync(async () =>
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
        }, token);
        token.ThrowIfCancellationRequested();
        Ready = true;
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

    private async Task ClearNavigationHighlightAsync()
    {
        if (Highlight is null)
        {
            return;
        }
        try
        {
            await Highlight.SendAsync("Overlay.hideHighlight");
        }
        catch (PlaywrightException) { }
    }

    private static Task WaitUntilAsync(Func<bool> ready, CancellationToken token) => WaitUntilAsync(() => Task.FromResult(ready()), token);
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

    [LoggerMessage(Level = LogLevel.Information, Message = "Display process {Process} exited")]
    private static partial void DisplayExited(ILogger logger, string process);
}
