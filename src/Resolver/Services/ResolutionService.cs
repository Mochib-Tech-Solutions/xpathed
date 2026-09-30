using System.Diagnostics;
using System.Text.Json;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Resolver.Services;

public sealed partial class ResolutionService(IHttpClientFactory clients, OpenRouterGateway gateway, IConfiguration configuration, ILogger<ResolutionService> logger)
{
    public async Task<ResolutionResult> ResolveAsync(string pageId, ResolutionRequest request, string traceId, CancellationToken cancellationToken)
    {
        var timer = Stopwatch.StartNew();
        var attemptId = Guid.NewGuid().ToString("N");
        CandidateCapture? capture = null;
        var multiple = request.ContractVersion == "2";
        var prompt = multiple ? ActionSelectionStrategy.Prompt : CandidateSelectionStrategy.Prompt;
        var schema = multiple ? ActionSelectionStrategy.Schema : CandidateSelectionStrategy.Schema;
        var outputTokens = multiple ? ActionSelectionStrategy.OutputTokens : 512;
        var strategy = configuration["Resolution:Strategy"] ?? "candidate-selection-v1";
        var diagnostics = new ResolutionDiagnostics { Stage = "configuration", Strategy = strategy, PromptVersion = multiple ? "5" : "4" };
        var configurationId = gateway.ConfigurationId(strategy, prompt, schema, diagnostics.ModelInputBudgetBytes, outputTokens, diagnostics.PromptVersion);
        try
        {
            if (strategy != "candidate-selection-v1")
            {
                throw new ApiException(422, "unsupported_strategy", "The configured resolution strategy is unavailable.");
            }
            gateway.EnsureConfigured();
            diagnostics = diagnostics with { Stage = "capture" };
            using var browser = clients.CreateClient("browser");
            using var captureResponse = await browser.PostAsJsonAsync($"/pages/{Uri.EscapeDataString(pageId)}/capture", new CaptureRequest(request.DocumentId), cancellationToken);
            await EnsureBrowserSuccessAsync(captureResponse, cancellationToken);
            capture = await captureResponse.Content.ReadFromJsonAsync<CandidateCapture>(cancellationToken)
                ?? throw new ApiException(502, "invalid_upstream_response", "The browser returned an invalid capture.");
            diagnostics.TimingsMs["capture"] = timer.Elapsed.TotalMilliseconds;
            diagnostics = diagnostics with { Capture = capture.Coverage };
            if (capture.Coverage is null || capture.Candidates is null || string.IsNullOrWhiteSpace(capture.SessionId) ||
                string.IsNullOrWhiteSpace(capture.CaptureId) || capture.FrameId != "main" || capture.UnsupportedBoundaryCount < 0)
            {
                throw new ApiException(502, "invalid_browser_capture", "The browser returned an invalid capture.");
            }
            if (capture.PageId != pageId || capture.DocumentId != request.DocumentId)
            {
                throw new ApiException(409, "stale_document", "The browser capture belongs to another page or document.");
            }
            if (!capture.Coverage.Complete)
            {
                throw new ApiException(502, "capture_incomplete", "The browser could not capture every eligible candidate.");
            }
            if (capture.Coverage.CapturedCount != capture.Candidates.Length || capture.Coverage.EligibleCount != capture.Candidates.Length ||
                capture.Coverage.ScannedCount < capture.Candidates.Length || capture.Candidates.Any(candidate =>
                    candidate is null || string.IsNullOrWhiteSpace(candidate.Id) || candidate.Id.Length > 80 ||
                    candidate.Tag is null || candidate.Role is null || candidate.Text is null || candidate.Label is null ||
                    candidate.Placeholder is null || candidate.Scope is null || candidate.State is null || candidate.Geometry is null || !ValidFrame(candidate.Frame, request.DocumentId)) ||
                capture.Candidates.Select(candidate => candidate.Id).Distinct(StringComparer.Ordinal).Count() != capture.Candidates.Length)
            {
                throw new ApiException(502, "invalid_browser_capture", "The browser returned inconsistent candidates or coverage.");
            }
            var input = CandidateSelectionStrategy.PrepareInput(request.Instruction, capture);
            diagnostics = diagnostics with
            {
                Stage = "model",
                Capture = capture.Coverage,
                ModelInputCount = capture.Candidates.Length,
                ModelInputComplete = capture.Coverage.Complete,
                ModelInputBytes = System.Text.Encoding.UTF8.GetByteCount(input)
            };
            if (diagnostics.ModelInputBytes > diagnostics.ModelInputBudgetBytes)
            {
                throw new ApiException(422, "model_input_budget_exceeded", "The complete page representation exceeds the model input budget.");
            }
            diagnostics = diagnostics with { ModelCalls = 1 };
            var completion = await gateway.CompleteAsync(prompt, input, schema, cancellationToken, outputTokens);
            diagnostics = diagnostics with
            {
                Model = completion.Diagnostics.Model,
                Provider = completion.Diagnostics.Provider,
                GenerationId = completion.Diagnostics.GenerationId,
                FinishReason = completion.Diagnostics.FinishReason,
                Usage = completion.Diagnostics.Usage,
                CostEstimate = completion.Diagnostics.CostEstimate
            };
            diagnostics.TimingsMs["model"] = timer.Elapsed.TotalMilliseconds - diagnostics.TimingsMs["capture"];
            if (completion.Diagnostics.Code is { } code)
            {
                throw new ApiException(502, code, "OpenRouter could not return a valid selection.");
            }
            if (multiple)
            {
                var selections = ActionSelectionStrategy.Select(completion.Content!, capture);
                diagnostics = diagnostics with { Stage = "selection" };
                var requestedActions = selections.Select((item, index) => new ActionSelection($"a{index + 1}", item.CandidateId, item.Action)).ToArray();
                using var response = await browser.PostAsJsonAsync($"/pages/{Uri.EscapeDataString(pageId)}/selections",
                    new ActionSelectionRequest(request.DocumentId, capture.CaptureId, requestedActions), cancellationToken);
                await EnsureBrowserSuccessAsync(response, cancellationToken);
                var validation = await response.Content.ReadFromJsonAsync<ActionSelectionValidation>(cancellationToken);
                if (validation?.Actions is null || validation.Actions.Length != selections.Length)
                {
                    throw new ApiException(502, "invalid_browser_selection", "The browser did not verify every action.");
                }
                var results = selections.Select((item, index) =>
                {
                    var verified = validation.Actions[index];
                    if (verified is null || verified.ActionId != requestedActions[index].ActionId ||
                        (item.Outcome == "found" ? !ValidTarget(verified.Target, item.CandidateId, item.Action, capture.Candidates.Single(candidate => candidate.Id == item.CandidateId).Frame) : verified.Target is not null))
                    {
                        throw new ApiException(502, "invalid_browser_selection", "The browser did not verify every action's target.");
                    }
                    var unsupportedScope = item.Outcome == "not_found" && capture.UnsupportedBoundaryCount > 0;
                    var code = unsupportedScope ? "unsupported_scope" : item.Limitation == "none" ? null : item.Limitation;
                    var message = unsupportedScope ? "Frame or shadow content is outside this capture's supported scope." : item.Limitation switch
                    {
                        "current_state_dependency" => "This step depends on a future page state. No earlier action was executed.",
                        "ambiguous" => "The instruction does not identify one intended target.",
                        "unsupported_action" => "This interaction is outside the supported action families.",
                        _ => item.Outcome == "not_found" ? "No matching element found in the eligible current-page scope." : null
                    };
                    return new ActionResolution(verified.ActionId, index + 1, item.Step, item.Instruction, item.Action,
                        unsupportedScope ? "unsupported" : item.Outcome, verified.Target, verified.Target?.Frame?.Id ?? capture.FrameId, attemptId, code, message);
                }).ToArray();
                var inspected = results.FirstOrDefault(item => item.Target is not null)?.ActionId;
                if (validation.InspectedActionId != inspected)
                {
                    throw new ApiException(502, "invalid_browser_selection", "The browser inspected another action.");
                }
                diagnostics.TimingsMs["validation"] = timer.Elapsed.TotalMilliseconds - diagnostics.TimingsMs["capture"] - diagnostics.TimingsMs["model"];
                diagnostics = diagnostics with { Stage = "complete" };
                var outcomes = results.Select(item => item.Outcome).Distinct().ToArray();
                var outcome = outcomes.Length == 1 ? outcomes[0] : "partial";
                var summary = new ResolutionSummary(true, "unverified", results.Length, results.Count(item => item.Outcome == "found"),
                    results.Count(item => item.Outcome == "not_found"), results.Count(item => item.Outcome == "unsupported"), 0,
                    results.Count(item => item.Target?.Interactability?.Status == "blocked"),
                    results.Count(item => item.Target is { Interactability: null } || item.Target?.Interactability?.Status == "unknown"),
                    results.Count(item => item.Target?.Interactability?.Status == "unsupported"));
                return Result(outcome, null, null) with { Actions = results, Summary = summary, InspectedActionId = inspected };
            }
            var selection = CandidateSelectionStrategy.Select(completion.Content!, capture);
            diagnostics = diagnostics with { Stage = "selection" };
            using var selectionResponse = await browser.PostAsJsonAsync($"/pages/{Uri.EscapeDataString(pageId)}/selection",
                new SelectionRequest(request.DocumentId, capture.CaptureId, selection.CandidateId, selection.Action), cancellationToken);
            await EnsureBrowserSuccessAsync(selectionResponse, cancellationToken);
            var validated = await selectionResponse.Content.ReadFromJsonAsync<SelectionValidation>(cancellationToken)
                ?? throw new ApiException(502, "invalid_upstream_response", "The browser returned an invalid selection.");
            if (selection.Outcome == "found"
                ? !ValidTarget(validated.Target, selection.CandidateId, selection.Action, capture.Candidates.Single(candidate => candidate.Id == selection.CandidateId).Frame)
                : validated.Target is not null)
            {
                throw new ApiException(502, "invalid_browser_selection", "The browser did not verify the selected target.");
            }
            diagnostics.TimingsMs["validation"] = timer.Elapsed.TotalMilliseconds - diagnostics.TimingsMs["capture"] - diagnostics.TimingsMs["model"];
            diagnostics = diagnostics with { Stage = "complete" };
            if (selection.Outcome == "not_found" && capture.UnsupportedBoundaryCount > 0)
            {
                diagnostics = diagnostics with { Code = "unsupported_scope", Message = "The page contains frame or shadow content outside this capture's supported scope." };
                return Result("unsupported", selection.Action, null);
            }
            if (selection.Outcome == "not_found")
            {
                diagnostics = diagnostics with { Message = "No matching element found in the eligible current-page scope." };
            }
            return Result(selection.Outcome, selection.Action, validated.Target);
        }
        catch (ApiException error)
        {
            return Failure(error.Code, error.Message);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return Failure(diagnostics.Stage == "model" ? "provider_timeout" : "browser_timeout", "An upstream service did not respond in time.");
        }
        catch (HttpRequestException)
        {
            return Failure(diagnostics.Stage == "model" ? "provider_unavailable" : "browser_unavailable", "An upstream service is unavailable.");
        }
        catch (JsonException)
        {
            return Failure("invalid_browser_response", "The browser returned an invalid response.");
        }

        ResolutionResult Failure(string code, string message)
        {
            diagnostics = diagnostics with { Code = code, Message = message };
            LogFailure(logger, code, traceId, attemptId);
            return Result("error", null, null);
        }

        ResolutionResult Result(string outcome, string? action, ResolvedTarget? target)
        {
            diagnostics.TimingsMs["total"] = timer.Elapsed.TotalMilliseconds;
            return new ResolutionResult(request.ContractVersion, outcome, capture?.SessionId, pageId, request.DocumentId,
                capture?.CaptureId, target?.Frame?.Id ?? capture?.FrameId, traceId, attemptId, configurationId,
                action, target, diagnostics, multiple ? [] : null);
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Resolution failed: {Code} {TraceId} {AttemptId}")]
    private static partial void LogFailure(ILogger logger, string code, string traceId, string attemptId);

    private static bool ValidTarget(ResolvedTarget? target, string? candidateId, string action, TargetFrame? frame) =>
        target is not null && SameFrame(target.Frame, frame) && target.CandidateId == candidateId && target.Xpaths is { Length: 1 } &&
        !target.Xpaths.Any(string.IsNullOrWhiteSpace) && target.State is not null && target.Geometry is not null && ValidInteractability(target, action);

    private static bool ValidFrame(TargetFrame? frame, string documentId) => frame is null ||
        !string.IsNullOrWhiteSpace(frame.Id) && !string.IsNullOrWhiteSpace(frame.DocumentId) && frame.Chain is { Length: <= 63 } &&
        (frame.Id == "main" ? frame.Chain.Length == 0 && frame.DocumentId == documentId : frame.Chain.Length > 0 && frame.Chain[^1]?.FrameId == frame.Id) &&
        frame.Chain.All(ancestor => ancestor is not null && !string.IsNullOrWhiteSpace(ancestor.FrameId) && !string.IsNullOrWhiteSpace(ancestor.Xpath) && ancestor.Label is not null) &&
        frame.Chain.Select(ancestor => ancestor.FrameId).Distinct(StringComparer.Ordinal).Count() == frame.Chain.Length;

    private static bool SameFrame(TargetFrame? actual, TargetFrame? expected) => actual is null ? expected is null :
        expected is not null && actual.Id == expected.Id && actual.DocumentId == expected.DocumentId &&
        actual.Chain is not null && actual.Chain.SequenceEqual(expected.Chain);

    private static bool ValidInteractability(ResolvedTarget target, string action)
    {
        if (target.State.Version == "1" && target.Interactability is null)
        {
            return true;
        }
        var assessment = target.Interactability;
        if (assessment?.Checks is not { } checks)
        {
            return false;
        }
        string[] readiness = [checks.CompatibleControl, checks.Enabled, checks.Writable, checks.Viewport, checks.PointerReception, checks.Keyboard];
        string[] values = [.. readiness, checks.Stability, checks.EventOutcome];
        return target.State.Version == "2" && target.State.AccessibilityExposed == true && target.State.Readonly is not null &&
            assessment is { Version: "1" or "2", Reasons: not null, Checks: not null } && assessment.Action == action &&
            (assessment.Status is "blocked" or "unknown" or "unsupported" || assessment is { Version: "2", Status: "ready" }) &&
            assessment.Reasons.All(reason => !string.IsNullOrWhiteSpace(reason)) &&
            values.All(value => value is "pass" or "fail" or "unknown" or "not_applicable") &&
            checks.EventOutcome == "unknown" &&
            (assessment.Status != "ready" || readiness.All(value => value is "pass" or "not_applicable") && readiness.Contains("pass", StringComparer.Ordinal)) &&
            (assessment.Status == "blocked") == values.Contains("fail", StringComparer.Ordinal);
    }

    private static async Task EnsureBrowserSuccessAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }
        string? code = null;
        try
        {
            var body = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken);
            if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("code", out var value) && value.ValueKind == JsonValueKind.String)
            {
                code = value.GetString();
            }
        }
        catch (JsonException)
        {
            // Invalid error bodies contain no trustworthy diagnostic data.
        }
        code = code is "page_not_found" or "inactive_page" or "stale_document" or "stale_capture" or "capture_budget_exceeded" or "capture_exposure_unknown" or "validation_budget_exceeded" or "unknown_candidate" or "xpath_validation_failed"
            ? code : "browser_unavailable";
        throw new ApiException((int)response.StatusCode, code, code == "inactive_page"
            ? "The active tab changed. Resolve the instruction again."
            : "The browser could not validate the current page and target.");
    }
}
