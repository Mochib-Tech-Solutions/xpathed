using System.Collections.Concurrent;
using System.Net.WebSockets;
using Xpathed.Browser.Protocol;
using Xpathed.Browser.Viewing;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

public sealed partial class BrowserSessions
{
    public Task<ActionSelectionValidation> SelectActionsAsync(
        string pageId,
        ActionSelectionRequest request,
        CancellationToken token
    )
    {
        if (request.Actions.Any(action => action is null))
        {
            throw new ApiException(400, "invalid_request", "Every action must be an object.");
        }
        if (
            request.Actions.Select(action => action.ActionId).Distinct(StringComparer.Ordinal).Count()
            != request.Actions.Length
        )
        {
            throw new ApiException(400, "invalid_actions", "Action identities must be unique.");
        }
        foreach (var action in request.Actions)
        {
            RequireAction(action.Action);
        }
        return OnPageAsync(
            pageId,
            async (session, page) =>
            {
                await RequireCaptureAsync(session, page, request.DocumentId, request.CaptureId);
                if (request.Actions.Any(action => action.CandidateId is not null))
                {
                    await page.Capture!.VerifyXPathProposalsAsync(
                        request.XpathEvidenceId,
                        request.XpathProposals ?? []
                    );
                }
                page.ActionSelections = null;
                var validation = await ValidateActionsAsync(
                    session,
                    page,
                    request.DocumentId,
                    request.CaptureId,
                    request.Actions
                );
                await HighlightTargetAsync(
                    session,
                    page,
                    request.DocumentId,
                    request.CaptureId,
                    validation.Actions.Select(action => action.Target).OfType<ResolvedTarget>().ToArray()
                );
                page.ActionSelections = request.Actions.ToDictionary(action => action.ActionId, StringComparer.Ordinal);
                return validation;
            },
            token
        );
    }

    public Task<ValidatedAction> InspectActionAsync(
        string pageId,
        InspectActionRequest request,
        CancellationToken token
    ) =>
        OnPageAsync(
            pageId,
            async (session, page) =>
            {
                await RequireCaptureAsync(session, page, request.DocumentId, request.CaptureId);
                if (
                    page.ActionSelections is null
                    || !page.ActionSelections.TryGetValue(request.ActionId, out var action)
                    || action.CandidateId is null
                )
                {
                    throw new ApiException(
                        409,
                        "unknown_action",
                        "This action has no verified target in the current capture."
                    );
                }
                var result = await ValidateActionsAsync(session, page, request.DocumentId, request.CaptureId, [action]);
                var selection = new SelectionValidation(result.Actions[0].Target);
                await HighlightTargetAsync(
                    session,
                    page,
                    request.DocumentId,
                    request.CaptureId,
                    selection.Target is { } target ? [target] : []
                );
                return new ValidatedAction(action.ActionId, selection.Target);
            },
            token
        );

    public Task SpotlightAsync(string pageId, SpotlightRequest request, CancellationToken token) =>
        OnPageAsync(
            pageId,
            async (session, page) =>
            {
                await RequireCaptureAsync(session, page, request.DocumentId, request.CaptureId);
                string? candidateId = null;
                if (request.ActionId is { } actionId)
                {
                    if (
                        page.ActionSelections is null
                        || !page.ActionSelections.TryGetValue(actionId, out var action)
                        || action.CandidateId is null
                    )
                    {
                        throw new ApiException(
                            409,
                            "unknown_action",
                            "This action has no verified target in the current capture."
                        );
                    }
                    var validation = await ValidateActionsAsync(
                        session,
                        page,
                        request.DocumentId,
                        request.CaptureId,
                        [action]
                    );
                    candidateId = validation.Actions[0].Target!.CandidateId;
                }
                await page.Capture!.SpotlightAsync(candidateId);
                await RequireCaptureAsync(session, page, request.DocumentId, request.CaptureId);
                return true;
            },
            token
        );

    public Task<ActionExecutionResult> ExecuteActionAsync(
        string pageId,
        ExecuteActionRequest request,
        CancellationToken token
    ) =>
        OnPageAsync(
            pageId,
            async (session, page) =>
            {
                if (session.Id != request.SessionId)
                {
                    throw new ApiException(409, "stale_session", "This action belongs to a different browser session.");
                }
                await RequireCaptureAsync(session, page, request.DocumentId, request.CaptureId);
                try
                {
                    if (
                        page.ActionSelections is null
                        || !page.ActionSelections.TryGetValue(request.ActionId, out var action)
                        || action.CandidateId is null
                    )
                    {
                        throw new ApiException(
                            409,
                            "unknown_action",
                            "This action has no verified target in the current capture."
                        );
                    }
                    BrowserActionExecution.Validate(action.Action, request.Value);
                    await page.ClearHighlightAsync();
                    var validation = await ValidateActionsAsync(
                        session,
                        page,
                        request.DocumentId,
                        request.CaptureId,
                        [action]
                    );
                    var target = validation.Actions[0].Target;
                    if (
                        target is not { State.Rendered: true, State.InViewport: true, Interactability: { } readiness }
                        || readiness.Status is "blocked" or "unsupported"
                        || readiness.Checks.CompatibleControl != "pass"
                        || (action.Action is "fill" or "type" or "clear" && readiness.Checks.Keyboard != "pass")
                    )
                    {
                        throw new ApiException(
                            409,
                            "action_not_ready",
                            "The target is no longer ready for this action. Resolve it again."
                        );
                    }
                    await using var element = await page.Capture!.RetainedTargetAsync(action.CandidateId);
                    await RequireCaptureAsync(session, page, request.DocumentId, request.CaptureId);
                    var point = await page.Capture.TargetPointAsync(action.CandidateId);
                    // Consume the capture before dispatch so an uncertain result cannot be replayed.
                    page.InvalidateCapture();
                    try
                    {
                        await CdpActions.ExecuteAsync(
                            element,
                            action.Action,
                            request.Value,
                            point.GetProperty("x").GetDouble(),
                            point.GetProperty("y").GetDouble()
                        );
                        if (page.Page.CurrentDialog is not null)
                        {
                            throw new CdpDialogPendingException();
                        }
                        return new ActionExecutionResult(
                            request.ActionId,
                            action.Action,
                            "completed",
                            "Browser action completed. Check the page for the result."
                        );
                    }
                    catch (Exception error) when (error is CdpException or TimeoutException)
                    {
                        return new ActionExecutionResult(
                            request.ActionId,
                            action.Action,
                            "uncertain",
                            "The browser could not confirm completion. Check the page before resolving again."
                        );
                    }
                }
                finally
                {
                    await page.ClearCaptureAsync();
                }
            },
            token
        );

    private static void RequireAction(string action)
    {
        if (
            action
            is not (
                "click"
                or "double_click"
                or "right_click"
                or "hover"
                or "fill"
                or "type"
                or "clear"
                or "select"
                or "check"
                or "uncheck"
                or "press"
                or "focus"
                or "blur"
                or "upload"
                or "inspect"
                or "unsupported"
            )
        )
        {
            throw new ApiException(400, "invalid_action", "The requested action is not supported.");
        }
    }

    private static async Task<ActionSelectionValidation> ValidateActionsAsync(
        BrowserSessionRuntime session,
        BrowserPageRuntime page,
        string documentId,
        string captureId,
        ActionSelection[] actions
    )
    {
        await RequireCaptureAsync(session, page, documentId, captureId);
        try
        {
            var result = await page.Capture!.SelectAsync(actions);
            await RequireCaptureAsync(session, page, documentId, captureId);
            if (
                actions.Any(action => action.CandidateId is not null)
                && !await page.Capture.XPathPrivacyUnchangedAsync()
            )
            {
                throw new ApiException(409, "stale_capture", "Private content changed while the target was verified.");
            }
            return result;
        }
        catch (CdpException)
        {
            await page.ClearHighlightAsync();
            throw new ApiException(409, "stale_capture", "The retained target document is no longer available.");
        }
        catch
        {
            await page.ClearHighlightAsync();
            throw;
        }
    }

    private static async Task HighlightTargetAsync(
        BrowserSessionRuntime session,
        BrowserPageRuntime page,
        string documentId,
        string captureId,
        ResolvedTarget[] targets
    )
    {
        await page.ClearHighlightAsync();
        try
        {
            if (targets.Length > 0)
            {
                await page.Capture!.HighlightAsync(targets);
            }
            await RequireCaptureAsync(session, page, documentId, captureId);
        }
        catch
        {
            await page.ClearHighlightAsync();
            throw;
        }
    }
}
