using System.Diagnostics;
using Xpathed.Common.Contracts;

namespace Xpathed.Resolver.Services;

internal sealed class ResolutionAttempt(
    ProviderAccounting accounting,
    string traceId,
    string attemptId,
    string configurationId,
    CancellationToken cancellationToken
)
{
    private readonly List<ResolutionDiagnostics> completedCalls = [];
    public required ResolutionDiagnostics Diagnostics { get; set; }

    public void RecordCompletedCalls()
    {
        foreach (var call in completedCalls)
        {
            accounting.Record(call, traceId, attemptId, configurationId);
        }
    }

    public async Task<ProviderCompletion> CallAsync(
        string purpose,
        Func<CancellationToken, Action<ResolutionDiagnostics>, Task<ProviderCompletion>> complete,
        bool includeImage = false
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        ResolutionDiagnostics? received = null;
        var callTimer = Stopwatch.StartNew();
        var pending = accounting.Start(token => complete(token, observed => Volatile.Write(ref received, observed)));
        var index = Diagnostics.ProviderCalls.Length;
        Diagnostics = Diagnostics with
        {
            ModelCalls = Diagnostics.ModelCalls + 1,
            ProviderCalls =
            [
                .. Diagnostics.ProviderCalls,
                new(purpose, null, null, null, null, null, "pending", null, 0),
            ],
            ProviderAccounting = purpose == "selection" ? "pending" : Diagnostics.ProviderAccounting,
            ImageRouting =
                purpose == "selection" && includeImage
                    ? Diagnostics.ImageRouting! with
                    {
                        Status = "included",
                    }
                    : Diagnostics.ImageRouting,
        };
        try
        {
            var completion = await pending.WaitAsync(cancellationToken);
            completedCalls.Add(completion.Diagnostics);
            Observe(completion.Diagnostics);
            return completion;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            var known = Volatile.Read(ref received);
            if (known is not null)
            {
                Observe(known);
            }
            _ = accounting.ObserveLateAsync(
                pending,
                traceId,
                attemptId,
                configurationId,
                false,
                () => Volatile.Read(ref received)
            );
            throw;
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            var evidence = Volatile.Read(ref received) ?? new ResolutionDiagnostics();
            evidence = evidence with
            {
                Code = error is OperationCanceledException ? "provider_timeout" : "provider_unavailable",
            };
            completedCalls.Add(evidence);
            Observe(evidence);
            throw;
        }

        void Observe(ResolutionDiagnostics evidence)
        {
            Diagnostics.ProviderCalls[index] = new(
                purpose,
                evidence.Model,
                evidence.Provider,
                evidence.GenerationId,
                evidence.Usage,
                evidence.CostEstimate,
                evidence.Usage?.Cost is not null ? "completed" : "unavailable",
                evidence.Code,
                callTimer.Elapsed.TotalMilliseconds
            );
            if (purpose == "selection")
            {
                Diagnostics = Diagnostics with
                {
                    Model = evidence.Model,
                    Provider = evidence.Provider,
                    GenerationId = evidence.GenerationId,
                    FinishReason = evidence.FinishReason,
                    Usage = evidence.Usage,
                    CostEstimate = evidence.CostEstimate,
                    ProviderAccounting = evidence.Usage?.Cost is not null ? "completed" : "unavailable",
                };
            }
        }
    }
}
