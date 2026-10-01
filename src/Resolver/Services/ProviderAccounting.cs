using Xpathed.Common.Contracts;
using Xpathed.Common.Diagnostics;
using Xpathed.Common.Http;

namespace Xpathed.Resolver.Services;

public sealed partial class ProviderAccounting(IHostApplicationLifetime lifetime, ILogger<ProviderAccounting> logger)
{
    private int active;

    internal Task<ProviderCompletion> Start(Func<CancellationToken, Task<ProviderCompletion>> complete)
    {
        // ponytail: process-wide cap of 32 pending calls; use a durable worker if restart-safe reconciliation is required.
        if (Interlocked.Increment(ref active) > 32)
        {
            Interlocked.Decrement(ref active);
            throw new ApiException(503, "provider_capacity_exceeded", "Provider accounting is at capacity.");
        }
        return RunAsync();

        async Task<ProviderCompletion> RunAsync()
        {
            try
            {
                return await complete(lifetime.ApplicationStopping);
            }
            finally
            {
                Interlocked.Decrement(ref active);
            }
        }
    }

    internal async Task ObserveLateAsync(
        Task<ProviderCompletion> pending,
        string traceId,
        string attemptId,
        string configurationId,
        bool usageAlreadyReturned,
        Func<ResolutionDiagnostics?> observedUsage
    )
    {
        try
        {
            var completion = await pending;
            if (usageAlreadyReturned)
            {
                return;
            }
            Record(completion.Diagnostics, traceId, attemptId, configurationId);
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            if (!usageAlreadyReturned)
            {
                if (observedUsage() is { } evidence)
                {
                    Record(evidence, traceId, attemptId, configurationId);
                }
                else
                {
                    LogUnavailable(logger, traceId, attemptId, configurationId, error.GetType().Name);
                }
            }
        }
    }

    internal void Record(ResolutionDiagnostics evidence, string traceId, string attemptId, string configurationId)
    {
        if (logger.IsEnabled(LogLevel.Warning))
        {
            LogLateAccounting(
                logger,
                traceId,
                attemptId,
                configurationId,
                DiagnosticSanitizer.SanitizeText(evidence.GenerationId),
                DiagnosticSanitizer.SanitizeText(evidence.Model),
                DiagnosticSanitizer.SanitizeText(evidence.Provider),
                evidence.Usage?.InputTokens,
                evidence.Usage?.OutputTokens,
                evidence.Usage?.TotalTokens,
                evidence.Usage?.ReasoningTokens,
                evidence.Usage?.CachedTokens,
                evidence.Usage?.Cost,
                evidence.Usage?.Cost is not null ? "completed" : "unavailable"
            );
        }
    }

    [LoggerMessage(
        Level = LogLevel.Warning,
        Message = "Late provider accounting: {TraceId} {AttemptId} {ConfigurationId} {GenerationId} {Model} {Provider} {InputTokens} {OutputTokens} {TotalTokens} {ReasoningTokens} {CachedTokens} {ReportedUsd} {AccountingStatus}"
    )]
    private static partial void LogLateAccounting(
        ILogger logger,
        string traceId,
        string attemptId,
        string configurationId,
        string? generationId,
        string? model,
        string? provider,
        long? inputTokens,
        long? outputTokens,
        long? totalTokens,
        long? reasoningTokens,
        long? cachedTokens,
        decimal? reportedUsd,
        string accountingStatus
    );

    [LoggerMessage(
        Level = LogLevel.Warning,
        Message = "Late provider accounting unavailable: {TraceId} {AttemptId} {ConfigurationId} {FailureType}"
    )]
    private static partial void LogUnavailable(
        ILogger logger,
        string traceId,
        string attemptId,
        string configurationId,
        string failureType
    );
}
