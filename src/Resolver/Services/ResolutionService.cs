using System.Diagnostics;
using System.Text.Json;
using Xpathed.Common.Contracts;
using Xpathed.Common.Diagnostics;
using Xpathed.Common.Http;

namespace Xpathed.Resolver.Services;

public sealed partial class ResolutionService(
    IHttpClientFactory clients,
    OpenRouterGateway gateway,
    ILogger<ResolutionService> logger,
    ProviderAccounting accounting
)
{
    public Task<ResolutionResult> ResolveAsync(
        string pageId,
        ResolutionRequest request,
        string traceId,
        CancellationToken cancellationToken
    ) => ResolveCoreAsync(pageId, request, traceId, cancellationToken);

    public async Task<DiagnosticResolution> ResolveWithEvidenceAsync(
        string pageId,
        ResolutionRequest request,
        string traceId,
        string? attemptId,
        CancellationToken cancellationToken
    )
    {
        string? input = null;
        var result = await ResolveCoreAsync(
            pageId,
            request,
            traceId,
            cancellationToken,
            attemptId,
            value => input = value
        );
        var sensitive =
            DiagnosticSanitizer.IsSensitiveInstruction(request.Instruction)
            || DiagnosticSanitizer.IsSensitiveAction(result.Action)
            || result.Actions?.Any(action => DiagnosticSanitizer.IsSensitiveAction(action.Action)) == true;
        var evidenceConfiguration = JsonSerializer.SerializeToNode(
            new
            {
                gateway.Model,
                gateway.Provider,
                result.ConfigurationId,
                result.Diagnostics.Strategy,
                result.Diagnostics.ModelInputBudgetBytes,
                outputTokens = ActionSelectionStrategy.OutputTokens,
                effective = gateway.DescribeConfiguration(),
            }
        )!;
        var evidence = new ResolutionEvidence(
            sensitive ? "withheld_sensitive_instruction"
                : input is null ? "model_input_unavailable"
                : "sanitized",
            sensitive ? DiagnosticSanitizer.Redacted : DiagnosticSanitizer.RedactInstruction(request.Instruction),
            sensitive || input is null ? null : DiagnosticSanitizer.SanitizeJson(input),
            ActionSelectionStrategy.Prompt,
            ActionSelectionStrategy.Schema.GetRawText(),
            DiagnosticSanitizer.SanitizeJson(evidenceConfiguration.ToJsonString())
        );
        return new DiagnosticResolution(result, evidence);
    }

    private async Task<ResolutionResult> ResolveCoreAsync(
        string pageId,
        ResolutionRequest request,
        string traceId,
        CancellationToken cancellationToken,
        string? suppliedAttemptId = null,
        Action<string>? observeInput = null
    )
    {
        var timer = Stopwatch.StartNew();
        var requestCancellation = cancellationToken;
        var attemptId = suppliedAttemptId ?? Guid.NewGuid().ToString("N");
        CandidateCapture? capture = null;
        var providerCompleted = false;
        var strategy = ActionSelectionStrategy.Strategy;
        var diagnostics = new ResolutionDiagnostics { Stage = "configuration", Strategy = strategy };
        var configurationId = gateway.ConfigurationId();
        try
        {
            gateway.EnsureConfigured();
            diagnostics = diagnostics with { Stage = "capture" };
            using var browser = clients.CreateClient("browser");
            using var captureResponse = await browser.PostAsJsonAsync(
                $"/pages/{Uri.EscapeDataString(pageId)}/capture",
                new CaptureRequest(request.DocumentId, "current_view"),
                cancellationToken
            );
            await EnsureBrowserSuccessAsync(captureResponse, cancellationToken);
            capture =
                await captureResponse.Content.ReadFromJsonAsync<CandidateCapture>(cancellationToken)
                ?? throw new ApiException(502, "invalid_upstream_response", "The browser returned an invalid capture.");
            diagnostics.TimingsMs["capture"] = timer.Elapsed.TotalMilliseconds;
            diagnostics = diagnostics with { Capture = capture.Coverage };
            BrowserEvidence.ValidateCapture(capture, pageId, request.DocumentId);
            var input = CandidateInput.PrepareInput(request.Instruction, capture);
            diagnostics = diagnostics with
            {
                Stage = "model",
                Capture = capture.Coverage,
                ModelInputCount = capture.Candidates.Length,
                ModelInputComplete = capture.Coverage.Complete,
                ModelInputBytes = System.Text.Encoding.UTF8.GetByteCount(input),
            };
            observeInput?.Invoke(input);
            cancellationToken.ThrowIfCancellationRequested();
            ProviderCompletion completion;
            ResolutionDiagnostics? received = null;
            var pending = accounting.Start(token =>
                gateway.CompleteAsync(input, token, observed => Volatile.Write(ref received, observed))
            );
            diagnostics = diagnostics with { ModelCalls = 1, ProviderAccounting = "pending" };
            try
            {
                completion = await pending.WaitAsync(cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                var known = Volatile.Read(ref received);
                if (known is not null)
                {
                    diagnostics = diagnostics with
                    {
                        Model = known.Model,
                        Provider = known.Provider,
                        GenerationId = known.GenerationId,
                        FinishReason = known.FinishReason,
                        Usage = known.Usage,
                        ProviderAccounting = known.Usage?.Cost is not null ? "completed" : "unavailable",
                    };
                }
                _ = accounting.ObserveLateAsync(
                    pending,
                    traceId,
                    attemptId,
                    configurationId,
                    known is not null && !requestCancellation.IsCancellationRequested,
                    () => Volatile.Read(ref received)
                );
                throw;
            }
            catch
            {
                diagnostics = diagnostics with { ProviderAccounting = "unavailable" };
                throw;
            }
            providerCompleted = true;
            diagnostics = diagnostics with
            {
                Model = completion.Diagnostics.Model,
                Provider = completion.Diagnostics.Provider,
                GenerationId = completion.Diagnostics.GenerationId,
                FinishReason = completion.Diagnostics.FinishReason,
                Usage = completion.Diagnostics.Usage,
                CostEstimate = completion.Diagnostics.CostEstimate,
                ProviderAccounting = completion.Diagnostics.Usage?.Cost is not null ? "completed" : "unavailable",
            };
            diagnostics.TimingsMs["model"] = timer.Elapsed.TotalMilliseconds - diagnostics.TimingsMs["capture"];
            if (completion.Diagnostics.Code is { } code)
            {
                throw new ApiException(502, code, "OpenRouter could not return a valid selection.");
            }
            cancellationToken.ThrowIfCancellationRequested();
            var selections = ActionSelectionStrategy.Select(completion.Content!, capture);
            diagnostics = diagnostics with { Stage = "selection" };
            var requestedActions = selections
                .Select((item, index) => new ActionSelection($"a{index + 1}", item.CandidateId, item.Action))
                .ToArray();
            using var response = await browser.PostAsJsonAsync(
                $"/pages/{Uri.EscapeDataString(pageId)}/selections",
                new ActionSelectionRequest(request.DocumentId, capture.CaptureId, requestedActions),
                cancellationToken
            );
            await EnsureBrowserSuccessAsync(response, cancellationToken);
            var validation = BrowserEvidence.ValidateSelection(
                capture,
                selections,
                requestedActions,
                await response.Content.ReadFromJsonAsync<ActionSelectionValidation>(cancellationToken)
            );
            var results = selections
                .Select(
                    (item, index) =>
                    {
                        var verified = validation.Actions[index];
                        var unsupportedScope = item.Outcome == "not_found" && capture.UnsupportedBoundaryCount > 0;
                        var code =
                            unsupportedScope ? "unsupported_scope"
                            : item.Limitation == "none" ? null
                            : item.Limitation;
                        var message = unsupportedScope
                            ? "Frame or shadow content is outside this capture's supported scope."
                            : item.Limitation switch
                            {
                                "current_state_dependency" =>
                                    "This step depends on a future page state. No earlier action was executed.",
                                "appearance_unavailable" =>
                                    "The requested appearance cannot be established from the captured CSS evidence.",
                                "ambiguous" => "The instruction does not identify one intended target.",
                                "unsupported_action" =>
                                    "Use one supported interaction type per command. It may target several elements in the current view; mixed interactions are unsupported.",
                                _ => item.Outcome == "not_found"
                                    ? "No matching element found in the current view."
                                    : null,
                            };
                        return new ActionResolution(
                            verified.ActionId,
                            index + 1,
                            item.Step,
                            item.Instruction,
                            item.Action,
                            unsupportedScope ? "unsupported" : item.Outcome,
                            verified.Target,
                            verified.Target?.Frame?.Id ?? capture.FrameId,
                            attemptId,
                            code,
                            message
                        );
                    }
                )
                .ToArray();
            var inspected = results.FirstOrDefault(item => item.Target is not null)?.ActionId;
            diagnostics.TimingsMs["validation"] =
                timer.Elapsed.TotalMilliseconds - diagnostics.TimingsMs["capture"] - diagnostics.TimingsMs["model"];
            diagnostics = diagnostics with { Stage = "complete" };
            var outcomes = results.Select(item => item.Outcome).Distinct().ToArray();
            var outcome = outcomes.Length == 1 ? outcomes[0] : "partial";
            var summary = new ResolutionSummary(
                true,
                "unverified",
                results.Length,
                results.Count(item => item.Outcome == "found"),
                results.Count(item => item.Outcome == "not_found"),
                results.Count(item => item.Outcome == "unsupported"),
                0,
                results.Count(item => item.Target?.Interactability?.Status == "blocked"),
                results.Count(item =>
                    item.Target is { Interactability: null } || item.Target?.Interactability?.Status == "unknown"
                ),
                results.Count(item => item.Target?.Interactability?.Status == "unsupported")
            );
            return Result(outcome, results[0].Action, null) with
            {
                Actions = results,
                Summary = summary,
                InspectedActionId = inspected,
            };
        }
        catch (ApiException error)
        {
            return Failure(error.Code, error.Message);
        }
        catch (OperationCanceledException) when (requestCancellation.IsCancellationRequested)
        {
            if (providerCompleted)
            {
                accounting.Record(diagnostics, traceId, attemptId, configurationId);
            }
            throw;
        }
        catch (OperationCanceledException)
        {
            return Failure(
                diagnostics.Stage == "model" ? "provider_timeout" : "browser_timeout",
                "An upstream service did not respond in time."
            );
        }
        catch (HttpRequestException)
        {
            return Failure(
                diagnostics.Stage == "model" ? "provider_unavailable" : "browser_unavailable",
                "An upstream service is unavailable."
            );
        }
        catch (JsonException)
        {
            return Failure("invalid_browser_response", "The browser returned an invalid response.");
        }

        ResolutionResult Failure(string code, string message)
        {
            var stage = diagnostics.Stage == "selection" ? "validation" : diagnostics.Stage;
            if (stage is "capture" or "model" or "validation")
            {
                diagnostics.TimingsMs[stage] =
                    timer.Elapsed.TotalMilliseconds
                    - (stage == "capture" ? 0 : diagnostics.TimingsMs.GetValueOrDefault("capture"))
                    - (stage == "validation" ? diagnostics.TimingsMs.GetValueOrDefault("model") : 0);
            }
            diagnostics = diagnostics with { Code = code, Message = message };
            LogFailure(logger, diagnostics.Stage, code, "error", traceId, attemptId, configurationId, attemptId);
            return Result("error", null, null);
        }

        ResolutionResult Result(string outcome, string? action, ResolvedTarget? target)
        {
            if (outcome != "error")
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            diagnostics.TimingsMs["total"] = timer.Elapsed.TotalMilliseconds;
            return new ResolutionResult(
                outcome,
                capture?.SessionId,
                pageId,
                request.DocumentId,
                capture?.CaptureId,
                target?.Frame?.Id ?? capture?.FrameId,
                traceId,
                attemptId,
                configurationId,
                action,
                target,
                diagnostics,
                []
            );
        }
    }

    [LoggerMessage(
        Level = LogLevel.Warning,
        Message = "Resolution failed: {Stage} {Code} {Outcome} {TraceId} {AttemptId} {ConfigurationId} {EvidenceReference}"
    )]
    private static partial void LogFailure(
        ILogger logger,
        string stage,
        string code,
        string outcome,
        string traceId,
        string attemptId,
        string configurationId,
        string evidenceReference
    );

    private static async Task EnsureBrowserSuccessAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken
    )
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }
        string? code = null;
        try
        {
            var body = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken);
            if (
                body.ValueKind == JsonValueKind.Object
                && body.TryGetProperty("code", out var value)
                && value.ValueKind == JsonValueKind.String
            )
            {
                code = value.GetString();
            }
        }
        catch (JsonException)
        {
            // Invalid error bodies contain no trustworthy diagnostic data.
        }
        code = code
            is "page_not_found"
                or "inactive_page"
                or "stale_document"
                or "stale_capture"
                or "capture_budget_exceeded"
                or "capture_exposure_unknown"
                or "validation_budget_exceeded"
                or "unknown_candidate"
                or "xpath_validation_failed"
            ? code
            : "browser_unavailable";
        throw new ApiException(
            (int)response.StatusCode,
            code,
            code switch
            {
                "inactive_page" => "The active tab changed. Resolve the instruction again.",
                "stale_capture" => "The page or current view changed. Resolve the instruction again.",
                _ => "The browser could not validate the current page and target.",
            }
        );
    }
}
