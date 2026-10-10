using System.Diagnostics;
using System.Text.Json;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Resolver.Services;

public sealed partial class ResolutionService(
    IHttpClientFactory clients,
    OpenRouterGateway gateway,
    ILogger<ResolutionService> logger,
    ProviderAccounting accounting,
    XPathSelectionService xpathSelection,
    ImageRoutingCache routingCache
)
{
    public async Task<ResolutionResult> ResolveAsync(
        string pageId,
        ResolutionRequest request,
        string traceId,
        CancellationToken cancellationToken
    )
    {
        var timer = Stopwatch.StartNew();
        var requestCancellation = cancellationToken;
        var attemptId = Guid.NewGuid().ToString("N");
        CandidateCapture? capture = null;
        var stageTimer = Stopwatch.StartNew();
        var strategy = ActionSelectionStrategy.Strategy;
        var configurationId = gateway.ConfigurationId();
        var attempt = new ResolutionAttempt(accounting, traceId, attemptId, configurationId, cancellationToken)
        {
            Diagnostics = new ResolutionDiagnostics
            {
                Stage = "configuration",
                Strategy = strategy,
                ImageRouting = new(request.ImageMode, "not_requested", "no_candidates"),
            },
        };
        try
        {
            gateway.EnsureConfigured();
            Stage("capture");
            using var browser = clients.CreateClient("browser");
            using var captureResponse = await browser.PostAsJsonAsync(
                $"/pages/{Uri.EscapeDataString(pageId)}/capture",
                new CaptureRequest(request.DocumentId),
                cancellationToken
            );
            await BrowserResponse.EnsureSuccessAsync(captureResponse, cancellationToken);
            capture =
                await captureResponse.Content.ReadFromJsonAsync<CandidateCapture>(cancellationToken)
                ?? throw new ApiException(502, "invalid_upstream_response", "The browser returned an invalid capture.");
            attempt.Diagnostics = attempt.Diagnostics with { Capture = capture.Coverage };
            BrowserEvidence.ValidateCapture(capture, pageId, request.DocumentId);
            FinishStage();
            var imageDecision = new ImageRoutingDecision(false, "no_candidates", null);
            var cachedRouting = false;
            if (request.ImageMode == "text_only")
            {
                imageDecision = new(false, "text_only_requested", null);
            }
            else if (capture.Candidates.Length > 0)
            {
                Stage("routing");
                var routingInput = ImageRoutingPolicy.PrepareInput(request.Instruction, capture);
                var routingKey = ImageRoutingCache.Key(configurationId, routingInput);
                try
                {
                    if (routingCache.TryGet(routingKey, out var savedDecision))
                    {
                        imageDecision = savedDecision!;
                        cachedRouting = true;
                    }
                    else
                    {
                        var routed = await attempt.CallAsync(
                            "image_routing",
                            (token, observe) => gateway.DecideImageAsync(routingInput, token, observe)
                        );
                        if (routed.Diagnostics.Code == "provider_identity_mismatch")
                        {
                            throw new ApiException(
                                502,
                                "provider_identity_mismatch",
                                "The image router returned an unexpected model or provider."
                            );
                        }
                        imageDecision = ImageRoutingPolicy.Decide(
                            routed.Diagnostics.Code is null ? routed.Content : null
                        );
                        routingCache.Store(routingKey, imageDecision);
                    }
                }
                catch (Exception error)
                    when (error is HttpRequestException
                        || error is OperationCanceledException && !cancellationToken.IsCancellationRequested
                    )
                {
                    imageDecision = ImageRoutingPolicy.Decide(null);
                }
                FinishStage();
            }
            attempt.Diagnostics = attempt.Diagnostics with
            {
                ImageRouting = new(
                    request.ImageMode,
                    "text_only",
                    imageDecision.Reason,
                    imageDecision.Score,
                    cachedRouting
                ),
            };
            if (imageDecision.IncludeImage)
            {
                Stage("image");
                try
                {
                    using var imageResponse = await browser.PostAsJsonAsync(
                        $"/pages/{Uri.EscapeDataString(pageId)}/capture-image",
                        new CaptureImageRequest(request.DocumentId, capture.CaptureId),
                        cancellationToken
                    );
                    await BrowserResponse.EnsureSuccessAsync(imageResponse, cancellationToken);
                    var image = await imageResponse.Content.ReadFromJsonAsync<CaptureImageResult>(cancellationToken);
                    BrowserEvidence.ValidateImage(capture, image);
                    capture = capture with { Image = image!.Image };
                }
                catch (ApiException error) when (error.Code == "capture_image_unavailable")
                {
                    attempt.Diagnostics = attempt.Diagnostics with
                    {
                        ImageRouting = attempt.Diagnostics.ImageRouting with
                        {
                            Status = "unavailable",
                            Reason = "image_unavailable",
                        },
                    };
                }
                FinishStage();
            }
            Stage("preparation");
            var input = CandidateInput.PrepareInput(request.Instruction, capture);
            attempt.Diagnostics = attempt.Diagnostics with
            {
                ModelInputCount = capture.Candidates.Length,
                ModelInputComplete = capture.Coverage.Complete,
                ModelInputBytes = System.Text.Encoding.UTF8.GetByteCount(input),
            };
            FinishStage();
            cancellationToken.ThrowIfCancellationRequested();
            Stage("model");
            var completion = await attempt.CallAsync(
                "selection",
                (token, observe) => gateway.CompleteAsync(input, token, observe, capture.Image),
                capture.Image is not null
            );
            attempt.Diagnostics = attempt.Diagnostics with
            {
                Model = completion.Diagnostics.Model,
                Provider = completion.Diagnostics.Provider,
                GenerationId = completion.Diagnostics.GenerationId,
                FinishReason = completion.Diagnostics.FinishReason,
                Usage = completion.Diagnostics.Usage,
                CostEstimate = completion.Diagnostics.CostEstimate,
                ProviderAccounting = completion.Diagnostics.Usage?.Cost is not null ? "completed" : "unavailable",
            };
            FinishStage();
            if (completion.Diagnostics.TimingsMs.TryGetValue("provider", out var providerMs))
            {
                // Provider transport is part of model time, not another serial stage.
                attempt.Diagnostics.TimingsMs["provider"] = providerMs;
            }
            if (completion.Diagnostics.Code is { } code)
            {
                throw new ApiException(502, code, "OpenRouter could not return a valid selection.");
            }
            cancellationToken.ThrowIfCancellationRequested();
            var selections = ActionSelectionStrategy.Select(completion.Content!, capture);
            Stage("validation");
            var requestedActions = selections
                .Select((item, index) => new ActionSelection($"a{index + 1}", item.CandidateId, item.Action))
                .ToArray();
            var validation = BrowserEvidence.ValidateSelection(
                capture,
                selections,
                requestedActions,
                await xpathSelection.SelectAsync(
                    pageId,
                    new ActionSelectionRequest(request.DocumentId, capture.CaptureId, requestedActions),
                    cancellationToken
                )
            );
            var results = BuildActions(selections, validation, capture, attemptId);
            var inspected = results.FirstOrDefault(item => item.Target is not null)?.ActionId;
            FinishStage();
            attempt.Diagnostics = attempt.Diagnostics with { Stage = "complete" };
            var outcomes = results.Select(item => item.Outcome).Distinct().ToArray();
            var outcome = outcomes.Length == 1 ? outcomes[0] : "partial";
            var summary = BuildSummary(results);
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
            attempt.RecordCompletedCalls();
            throw;
        }
        catch (OperationCanceledException)
        {
            return Failure(
                attempt.Diagnostics.Stage == "model" ? "provider_timeout" : "browser_timeout",
                "An upstream service did not respond in time."
            );
        }
        catch (HttpRequestException)
        {
            return Failure(
                attempt.Diagnostics.Stage == "model" ? "provider_unavailable" : "browser_unavailable",
                "An upstream service is unavailable."
            );
        }
        catch (JsonException)
        {
            return Failure("invalid_browser_response", "The browser returned an invalid response.");
        }

        void Stage(string stage)
        {
            attempt.Diagnostics = attempt.Diagnostics with { Stage = stage };
            stageTimer.Restart();
        }

        void FinishStage() =>
            attempt.Diagnostics.TimingsMs[attempt.Diagnostics.Stage] = stageTimer.Elapsed.TotalMilliseconds;

        ResolutionResult Failure(string code, string message)
        {
            FinishStage();
            attempt.Diagnostics = attempt.Diagnostics with { Code = code, Message = message };
            LogFailure(
                logger,
                attempt.Diagnostics.Stage,
                code,
                "error",
                traceId,
                attemptId,
                configurationId,
                attemptId
            );
            return Result("error", null, null);
        }

        ResolutionResult Result(string outcome, string? action, ResolvedTarget? target)
        {
            if (outcome != "error")
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            attempt.Diagnostics.TimingsMs["total"] = timer.Elapsed.TotalMilliseconds;
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
                attempt.Diagnostics,
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
}
