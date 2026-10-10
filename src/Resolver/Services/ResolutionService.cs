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
        var completedCalls = new List<ResolutionDiagnostics>();
        var stageTimer = Stopwatch.StartNew();
        var strategy = ActionSelectionStrategy.Strategy;
        var diagnostics = new ResolutionDiagnostics
        {
            Stage = "configuration",
            Strategy = strategy,
            ImageRouting = new(request.ImageMode, "not_requested", "no_candidates"),
        };
        var configurationId = gateway.ConfigurationId();
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
            diagnostics = diagnostics with { Capture = capture.Coverage };
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
                        var routed = await CallProviderAsync(
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
            diagnostics = diagnostics with
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
                    diagnostics = diagnostics with
                    {
                        ImageRouting = diagnostics.ImageRouting with
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
            diagnostics = diagnostics with
            {
                ModelInputCount = capture.Candidates.Length,
                ModelInputComplete = capture.Coverage.Complete,
                ModelInputBytes = System.Text.Encoding.UTF8.GetByteCount(input),
            };
            FinishStage();
            cancellationToken.ThrowIfCancellationRequested();
            Stage("model");
            var completion = await CallProviderAsync(
                "selection",
                (token, observe) => gateway.CompleteAsync(input, token, observe, capture.Image)
            );
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
            FinishStage();
            if (completion.Diagnostics.TimingsMs.TryGetValue("provider", out var providerMs))
            {
                // Provider transport is part of model time, not another serial stage.
                diagnostics.TimingsMs["provider"] = providerMs;
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
                                    "This command requires separate steps or a page change. No action was executed.",
                                "appearance_unavailable" =>
                                    "The requested appearance cannot be established from the captured view.",
                                "state_unavailable" =>
                                    "The checked, selected or form-value distinction is not available. Identify the target by its name, section or position.",
                                "target_not_addressable" =>
                                    "The requested detail has no separate captured element. Choose the whole graphic or a separately exposed control.",
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
            FinishStage();
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
            foreach (var call in completedCalls)
            {
                accounting.Record(call, traceId, attemptId, configurationId);
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

        void Stage(string stage)
        {
            diagnostics = diagnostics with { Stage = stage };
            stageTimer.Restart();
        }

        void FinishStage() => diagnostics.TimingsMs[diagnostics.Stage] = stageTimer.Elapsed.TotalMilliseconds;

        async Task<ProviderCompletion> CallProviderAsync(
            string purpose,
            Func<CancellationToken, Action<ResolutionDiagnostics>, Task<ProviderCompletion>> complete
        )
        {
            cancellationToken.ThrowIfCancellationRequested();
            ResolutionDiagnostics? received = null;
            var callTimer = Stopwatch.StartNew();
            var pending = accounting.Start(token =>
                complete(token, observed => Volatile.Write(ref received, observed))
            );
            var index = diagnostics.ProviderCalls.Length;
            diagnostics = diagnostics with
            {
                ModelCalls = diagnostics.ModelCalls + 1,
                ProviderCalls =
                [
                    .. diagnostics.ProviderCalls,
                    new(purpose, null, null, null, null, null, "pending", null, 0),
                ],
                ProviderAccounting = purpose == "selection" ? "pending" : diagnostics.ProviderAccounting,
                ImageRouting =
                    purpose == "selection" && capture?.Image is not null
                        ? diagnostics.ImageRouting! with
                        {
                            Status = "included",
                        }
                        : diagnostics.ImageRouting,
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
                diagnostics.ProviderCalls[index] = new(
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
                    diagnostics = diagnostics with
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

        ResolutionResult Failure(string code, string message)
        {
            FinishStage();
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
}
