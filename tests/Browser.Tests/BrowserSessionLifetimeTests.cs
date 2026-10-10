using Xpathed.Browser.Sessions;
using Xpathed.Browser.Viewing;

namespace Xpathed.Browser.Tests;

public sealed class BrowserSessionLifetimeTests
{
    [Fact]
    public async Task PollingCannotExtendDisconnectedViewerGrace()
    {
        await using var session = new BrowserSessionRuntime(0, "chromium", new("1280x800", 1280, 800), "");
        var disconnected = DateTimeOffset.UtcNow;
        session.ViewerDisconnectedAt = disconnected;
        session.LastSeen = disconnected.AddMinutes(1);

        Assert.False(session.IsExpired(disconnected.AddSeconds(59)));
        Assert.True(session.IsExpired(disconnected.AddMinutes(1)));
    }

    [Fact]
    public async Task ReconnectedViewerClearsThePreviousDeadline()
    {
        await using var session = new BrowserSessionRuntime(0, "chromium", new("1280x800", 1280, 800), "");
        using var viewer = new BrowserViewerRelay();
        session.Viewer = viewer;
        session.ViewerDisconnectedAt = null;
        var now = DateTimeOffset.UtcNow;
        session.LastSeen = now;

        Assert.False(session.IsExpired(now.AddMinutes(2)));
        Assert.False(session.IsExpired(now.AddMinutes(15)));
        await session.Stop.CancelAsync();
        Assert.True(session.IsExpired(now));
    }

    [Fact]
    public async Task ApiOnlySessionRetainsItsIdleTimeout()
    {
        await using var session = new BrowserSessionRuntime(0, "chromium", new("1280x800", 1280, 800), "");
        var now = DateTimeOffset.UtcNow;
        session.LastSeen = now;

        Assert.False(session.IsExpired(now.AddMinutes(14)));
        Assert.True(session.IsExpired(now.AddMinutes(15)));
    }
}
