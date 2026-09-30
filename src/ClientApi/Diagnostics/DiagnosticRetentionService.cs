namespace Xpathed.ClientApi.Diagnostics;

public sealed partial class DiagnosticRetentionService(
    IServiceScopeFactory scopes,
    TimeProvider clock,
    ILogger<DiagnosticRetentionService> logger
) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = scopes.CreateScope();
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                timeout.CancelAfter(TimeSpan.FromSeconds(10));
                await scope.ServiceProvider.GetRequiredService<DiagnosticStore>().PruneAsync(timeout.Token);
            }
            catch (Exception error) when (!stoppingToken.IsCancellationRequested && error is not OutOfMemoryException)
            {
                LogRetentionFailure(logger, error.GetType().Name);
            }
            await Task.Delay(TimeSpan.FromHours(1), clock, stoppingToken);
        }
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Diagnostic retention failed: {ExceptionType}")]
    private static partial void LogRetentionFailure(ILogger logger, string exceptionType);
}
