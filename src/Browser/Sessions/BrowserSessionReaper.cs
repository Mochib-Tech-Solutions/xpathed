namespace Xpathed.Browser.Sessions;

internal sealed class BrowserSessionReaper(BrowserSessions sessions) : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken) => sessions.ReapAsync(stoppingToken);
}
