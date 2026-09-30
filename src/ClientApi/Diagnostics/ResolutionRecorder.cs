using System.Diagnostics;
using System.Net;
using System.Text.Json;
using Xpathed.Common.Contracts;
using Xpathed.Common.Diagnostics;
using Xpathed.Common.Http;

namespace Xpathed.ClientApi.Diagnostics;

public sealed partial class ResolutionRecorder(
    IHttpClientFactory clients,
    DiagnosticStore store,
    ILogger<ResolutionRecorder> logger
)
{
    public async Task<ResolutionResult> ResolveAsync(
        string pageId,
        ResolutionRequest request,
        CancellationToken cancellationToken
    )
    {
        var attempt = Guid.NewGuid().ToString("N");
        var trace = Activity.Current?.TraceId.ToString() ?? Guid.NewGuid().ToString("N");
        var knownRequest = new
        {
            instruction = DiagnosticSanitizer.RedactInstruction(request.Instruction),
            pageId,
            documentId = request.DocumentId,
            contractVersion = request.ContractVersion,
            outcome = "pending",
            attemptId = attempt,
            traceId = trace,
        };
        await TryRecordAsync(
            token => store.BeginAsync(attempt, trace, pageId, JsonSerializer.Serialize(knownRequest), token),
            attempt,
            trace
        );
        try
        {
            using var client = clients.CreateClient("resolver");
            using var message = new HttpRequestMessage(
                HttpMethod.Post,
                $"/internal/pages/{Uri.EscapeDataString(pageId)}/resolve"
            )
            {
                Content = JsonContent.Create(request),
            };
            message.Headers.Add("X-Xpathed-Attempt-Id", attempt);
            using var response = await client.SendAsync(
                message,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken
            );
            if (!response.IsSuccessStatusCode)
            {
                throw new ApiException(
                    (int)response.StatusCode,
                    "resolver_unavailable",
                    "The resolver could not process this request."
                );
            }
            await response.Content.LoadIntoBufferAsync(2_000_000, cancellationToken);
            var payload = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken);
            var result =
                payload.GetProperty("result").Deserialize<ResolutionResult>(DiagnosticStore.JsonOptions)
                ?? throw new JsonException();
            if (
                result.AttemptId != attempt
                || result.PageId != pageId
                || result.DocumentId != request.DocumentId
                || result.ContractVersion != request.ContractVersion
                || result.Diagnostics is null
                || string.IsNullOrWhiteSpace(result.TraceId)
                || string.IsNullOrWhiteSpace(result.ConfigurationId)
                || result.Outcome is not ("found" or "not_found" or "unsupported" or "error" or "partial")
            )
            {
                throw new JsonException();
            }
            var evidence =
                payload.TryGetProperty("evidence", out var item) && item.ValueKind == JsonValueKind.Object
                    ? item.GetRawText()
                    : null;
            var availability =
                evidence is not null && item.TryGetProperty("availability", out var state)
                    ? state.GetString() ?? "unavailable"
                    : "unavailable";
            await TryRecordAsync(
                token =>
                    store.CompleteAsync(
                        attempt,
                        result.Outcome,
                        DiagnosticSanitizer.SanitizeJson(
                            JsonSerializer.Serialize(result, DiagnosticStore.JsonOptions),
                            request.Instruction
                        ),
                        evidence is null ? null : DiagnosticSanitizer.SanitizeJson(evidence, request.Instruction),
                        availability,
                        token
                    ),
                attempt,
                trace
            );
            LogResolution(
                logger,
                result.Diagnostics.Stage,
                result.Diagnostics.Code ?? "none",
                result.Outcome,
                trace,
                attempt,
                result.ConfigurationId
            );
            return result;
        }
        catch (Exception error)
            when (error
                    is HttpRequestException
                        or OperationCanceledException
                        or JsonException
                        or ApiException
                        or InvalidOperationException
                        or KeyNotFoundException
            )
        {
            var code = error switch
            {
                OperationCanceledException when cancellationToken.IsCancellationRequested => "cancelled",
                OperationCanceledException => "resolver_timeout",
                ApiException api => api.Code,
                HttpRequestException => "resolver_unavailable",
                _ => "invalid_resolver_response",
            };
            await TryRecordAsync(
                token =>
                    store.CompleteAsync(
                        attempt,
                        "error",
                        JsonSerializer.Serialize(
                            new
                            {
                                outcome = "error",
                                instruction = knownRequest.instruction,
                                pageId,
                                documentId = request.DocumentId,
                                contractVersion = request.ContractVersion,
                                attemptId = attempt,
                                traceId = trace,
                                diagnostics = new
                                {
                                    stage = "resolver_transport",
                                    code,
                                    missingEvidence = true,
                                },
                            }
                        ),
                        null,
                        "unavailable",
                        token
                    ),
                attempt,
                trace
            );
            LogResolutionFailure(logger, code, trace, attempt);
            if (error is OperationCanceledException && cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            throw new ApiException(
                error is ApiException apiError ? apiError.Status : (int)HttpStatusCode.BadGateway,
                code,
                "The resolver could not complete this request."
            );
        }
    }

    private async Task TryRecordAsync(Func<CancellationToken, Task> operation, string attempt, string trace)
    {
        try
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            await operation(deadline.Token);
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            LogStorageFailure(logger, attempt, trace, error.GetType().Name);
        }
    }

    [LoggerMessage(
        Level = LogLevel.Error,
        Message = "Diagnostic storage unavailable: {AttemptId} {TraceId} {ExceptionType}"
    )]
    private static partial void LogStorageFailure(
        ILogger logger,
        string attemptId,
        string traceId,
        string exceptionType
    );

    [LoggerMessage(
        Level = LogLevel.Information,
        Message = "Resolution completed: {Stage} {Code} {Outcome} {TraceId} {AttemptId} {ConfigurationId}"
    )]
    private static partial void LogResolution(
        ILogger logger,
        string stage,
        string code,
        string outcome,
        string traceId,
        string attemptId,
        string configurationId
    );

    [LoggerMessage(
        Level = LogLevel.Warning,
        Message = "Resolution transport failure: stage=resolver_transport outcome=error configuration=unavailable {Code} {TraceId} {AttemptId}"
    )]
    private static partial void LogResolutionFailure(ILogger logger, string code, string traceId, string attemptId);
}
