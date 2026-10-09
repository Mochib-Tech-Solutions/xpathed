using System.Collections.Concurrent;
using System.Net.WebSockets;
using Xpathed.Browser.Protocol;
using Xpathed.Browser.Viewing;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

public sealed class BrowserSessions(IConfiguration configuration) : IAsyncDisposable
{
    private readonly ConcurrentDictionary<string, BrowserSessionRuntime> sessions = new();
    private readonly SemaphoreSlim creation = new(1);
    private readonly int capacity = Math.Clamp(configuration.GetValue("MaxSessions", 4), 1, 16);

    private readonly string defaultBrowserType = ValidateBrowserType(configuration["DefaultBrowserType"] ?? "chromium");

    private static readonly BrowserResolution[] Resolutions =
    [
        new("1024x768", 1024, 768),
        new("1280x800", 1280, 800),
        new("1366x768", 1366, 768),
        new("1440x900", 1440, 900),
        new("1920x1080", 1920, 1080),
    ];

    public BrowserSessionOptions Options => new(defaultBrowserType, ["chromium"], "1280x800", Resolutions);

    private static string ValidateBrowserType(string browserType) =>
        browserType is "chromium"
            ? browserType
            : throw new ApiException(400, "invalid_browser_type", "Choose Chromium.");

    public async Task<BrowserSession> CreateAsync(string? browserType, string? resolutionId, CancellationToken token)
    {
        browserType = ValidateBrowserType(browserType ?? defaultBrowserType);
        var resolution =
            Resolutions.FirstOrDefault(choice => choice.Id == (resolutionId ?? "1280x800"))
            ?? throw new ApiException(400, "invalid_resolution", "Choose a supported browser resolution.");
        await creation.WaitAsync(token);
        BrowserSessionRuntime? session = null;
        try
        {
            var slot = Enumerable.Range(0, capacity).FirstOrDefault(i => sessions.Values.All(s => s.Slot != i), -1);
            if (slot < 0)
            {
                throw new ApiException(
                    409,
                    "session_limit",
                    $"Close a session before opening another (limit {capacity})."
                );
            }

            session = new BrowserSessionRuntime(
                slot,
                browserType,
                resolution,
                configuration["BrowserExecutablePath"] ?? ""
            );
            sessions[session.Id] = session;
            await session.Gate.WaitAsync(token);
            try
            {
                await session.StartAsync(token);
                return new(
                    session.Id,
                    session.ActivePageId,
                    session.ViewPath,
                    session.BrowserType,
                    session.Resolution.Id
                );
            }
            finally
            {
                session.Gate.Release();
            }
        }
        catch
        {
            if (session is not null)
            {
                await CloseAsync(session.Id);
            }

            throw;
        }
        finally
        {
            creation.Release();
        }
    }

    internal BrowserSessionRuntime FindSession(string sessionId)
    {
        if (!sessions.TryGetValue(sessionId, out var session) || !session.Ready || session.Stop.IsCancellationRequested)
        {
            throw new ApiException(
                404,
                "session_not_found",
                "This session is closed or no longer available. Start a fresh session."
            );
        }

        session.LastSeen = DateTimeOffset.UtcNow;
        return session;
    }

    private Task<T> OnPageAsync<T>(
        string pageId,
        Func<BrowserSessionRuntime, BrowserPageRuntime, Task<T>> operation,
        CancellationToken token,
        bool requireActive = true
    )
    {
        var session =
            sessions.Values.FirstOrDefault(s =>
                s.Pages.ContainsKey(pageId) && s.Ready && !s.Stop.IsCancellationRequested
            ) ?? throw new ApiException(404, "page_not_found", "This page is closed or no longer available.");
        return OnSessionAsync(
            session,
            s =>
            {
                if (!s.Pages.TryGetValue(pageId, out var page) || page.Page.IsClosed)
                {
                    throw new ApiException(404, "page_not_found", "This page is closed.");
                }
                if (requireActive)
                {
                    RequireActive(s, page);
                }

                return operation(s, page);
            },
            token
        );
    }

    private async Task<T> OnSessionAsync<T>(
        BrowserSessionRuntime session,
        Func<BrowserSessionRuntime, Task<T>> operation,
        CancellationToken token
    )
    {
        session.LastSeen = DateTimeOffset.UtcNow;
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, session.Stop.Token);
        await session.Gate.WaitAsync(linked.Token);
        try
        {
            if (session.Stop.IsCancellationRequested)
            {
                throw new ApiException(404, "page_not_found", "This page is closed.");
            }

            var task = operation(session);
            try
            {
                return await task.WaitAsync(linked.Token);
            }
            catch (OperationCanceledException)
            {
                // A running browser command cannot be cancelled safely while retaining the page.
                await session.DisposeAsync();
                try
                {
                    await task;
                }
                catch (Exception) { }
                sessions.TryRemove(session.Id, out _);
                throw;
            }
            catch (TimeoutException)
            {
                throw new ApiException(504, "navigation_timeout", "The page did not respond in time.");
            }
            catch (CdpDialogPendingException)
            {
                throw new ApiException(409, "dialog_pending", "Answer the browser dialog first.");
            }
            catch (CdpException)
            {
                throw new ApiException(
                    502,
                    "browser_operation_failed",
                    "The browser could not complete this operation."
                );
            }
        }
        finally
        {
            session.Gate.Release();
        }
    }

    public Task<BrowserSessionState> SessionStateAsync(string sessionId, CancellationToken token) =>
        OnSessionAsync(FindSession(sessionId), s => s.StateAsync(), token);

    public Task<BrowserSessionState> NewPageAsync(string sessionId, CancellationToken token) =>
        OnSessionAsync(
            FindSession(sessionId),
            async s =>
            {
                await s.NewPageAsync();
                return await s.StateAsync();
            },
            token
        );

    public Task<BrowserSessionState> ActivateAsync(string pageId, CancellationToken token) =>
        OnPageAsync(
            pageId,
            async (s, page) =>
            {
                await s.ActivateAsync(page);
                return await s.StateAsync();
            },
            token,
            requireActive: false
        );

    public Task<BrowserSessionState> ClosePageAsync(string pageId, CancellationToken token) =>
        OnPageAsync(
            pageId,
            async (s, page) =>
            {
                await s.ClosePageAsync(page);
                return await s.StateAsync();
            },
            token,
            requireActive: false
        );

    public Task<PageState> StateAsync(string pageId, CancellationToken token) =>
        OnPageAsync(
            pageId,
            async (s, page) =>
                new PageState(
                    s.Id,
                    page.Id,
                    page.Page.Url,
                    await page.Page.TitleAsync(),
                    s.BlockedPopups,
                    page.DocumentId
                ),
            token,
            requireActive: false
        );

    public Task<PageState> NavigateAsync(string pageId, string url, CancellationToken token)
    {
        if (
            url.Length > 8192
            || !Uri.TryCreate(url, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https")
            || !string.IsNullOrEmpty(uri.UserInfo)
        )
        {
            throw new ApiException(400, "invalid_url", "Enter an HTTP or HTTPS address without embedded credentials.");
        }

        return OnPageAsync(
            pageId,
            async (s, page) =>
            {
                await page.Page.NavigateAsync(url);
                return new PageState(
                    s.Id,
                    page.Id,
                    page.Page.Url,
                    await page.Page.TitleAsync(),
                    s.BlockedPopups,
                    page.DocumentId
                );
            },
            token
        );
    }

    public Task<PageInspection> InspectAsync(string pageId, CancellationToken token) =>
        OnPageAsync(
            pageId,
            async (s, page) =>
            {
                var scrollY = await page.Page.EvaluateAsync<double>("window.scrollY");
                RequireActive(s, page);
                return new PageInspection(
                    s.Id,
                    page.Id,
                    page.Page.Url,
                    await page.Page.TitleAsync(),
                    scrollY,
                    DateTimeOffset.UtcNow
                );
            },
            token
        );

    public Task<CandidateCapture> CaptureAsync(string pageId, CaptureRequest request, CancellationToken token) =>
        OnPageAsync(
            pageId,
            async (s, page) =>
            {
                await RequireFocusedDocumentAsync(s, page, request.DocumentId);
                await page.ClearCaptureAsync();
                await page.BeginCaptureAsync();
                page.CaptureId = Guid.NewGuid().ToString("N");
                var captureId = page.CaptureId;
                page.Capture = new BrowserPageCapture(page);
                var result = await page.Capture.CaptureAsync(s.Id, request.DocumentId, captureId);
                if (request.IncludeImage)
                {
                    result = result with { Image = await page.Capture.CaptureImageAsync() };
                }
                await RequireFocusedDocumentAsync(s, page, request.DocumentId);
                if (page.CaptureId != captureId)
                {
                    throw new ApiException(409, "stale_capture", "This capture is no longer current.");
                }
                if (!await page.Capture.PrivacyUnchangedAsync())
                {
                    throw new ApiException(
                        409,
                        "stale_capture",
                        "Private content changed while the page was captured."
                    );
                }

                return result;
            },
            token
        );

    public Task<CaptureImageResult> CaptureImageAsync(
        string pageId,
        CaptureImageRequest request,
        CancellationToken token
    ) =>
        OnPageAsync(
            pageId,
            async (session, page) =>
            {
                await RequireCaptureAsync(session, page, request.DocumentId, request.CaptureId);
                var capture = page.Capture!;
                await capture.RequireImageCurrentAsync();
                CaptureImage image;
                try
                {
                    image = await capture.CaptureImageAsync();
                }
                catch (ApiException error) when (error.Code == "capture_image_unavailable")
                {
                    await RequireCurrentAsync();
                    throw;
                }
                await RequireCurrentAsync();
                return new CaptureImageResult(session.Id, page.Id, request.DocumentId, request.CaptureId, image);

                async Task RequireCurrentAsync()
                {
                    await RequireCaptureAsync(session, page, request.DocumentId, request.CaptureId);
                    await capture.RequireImageCurrentAsync();
                    RequireDocument(session, page, request.DocumentId);
                    if (page.Capture != capture || page.CaptureId != request.CaptureId)
                    {
                        throw new ApiException(409, "stale_capture", "This capture is no longer current.");
                    }
                }
            },
            token
        );

    public Task<XPathEvidenceBatch> XPathEvidenceAsync(
        string pageId,
        XPathEvidenceRequest request,
        CancellationToken token
    ) =>
        OnPageAsync(
            pageId,
            async (session, page) =>
            {
                await RequireCaptureAsync(session, page, request.DocumentId, request.CaptureId);
                page.ActionSelections = null;
                var evidence = await page.Capture!.XPathEvidenceAsync(request.CandidateIds);
                await RequireCaptureAsync(session, page, request.DocumentId, request.CaptureId);
                if (!await page.Capture.XPathPrivacyUnchangedAsync())
                {
                    throw new ApiException(
                        409,
                        "stale_capture",
                        "Private content changed while the page was observed."
                    );
                }
                return evidence;
            },
            token
        );

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

    private static async Task RequireCaptureAsync(
        BrowserSessionRuntime session,
        BrowserPageRuntime page,
        string documentId,
        string captureId
    )
    {
        await RequireFocusedDocumentAsync(session, page, documentId);
        if (page.Capture is null || page.CaptureId != captureId)
        {
            throw new ApiException(409, "stale_capture", "This capture is no longer current.");
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

    private static void RequireActive(BrowserSessionRuntime session, BrowserPageRuntime page)
    {
        if (session.ActivePageId != page.Id || session.HasPendingPages)
        {
            throw new ApiException(
                409,
                "inactive_page",
                "The active browser tab changed. Resolve the instruction on the current tab."
            );
        }
    }

    private static void RequireDocument(BrowserSessionRuntime session, BrowserPageRuntime page, string documentId)
    {
        RequireActive(session, page);
        if (page.DocumentId != documentId)
        {
            throw new ApiException(409, "stale_document", "The page changed while this request was running.");
        }
    }

    private static async Task RequireFocusedDocumentAsync(
        BrowserSessionRuntime session,
        BrowserPageRuntime page,
        string documentId
    )
    {
        RequireDocument(session, page, documentId);
        if (page.Page.CurrentDialog is not null)
        {
            throw new ApiException(409, "dialog_pending", "Answer the browser dialog first.");
        }
        if (!await page.HasNativeFocusAsync())
        {
            page.InvalidateCapture();
            throw new ApiException(
                409,
                "inactive_page",
                "The active browser tab changed. Resolve the instruction on the current tab."
            );
        }
        RequireDocument(session, page, documentId);
    }

    public async Task ConnectViewerAsync(string sessionId, WebSocket socket, CancellationToken token)
    {
        var session = FindSession(sessionId);
        using var relay = new BrowserViewerRelay();
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(token, session.Stop.Token);
        try
        {
            await session.Gate.WaitAsync(lifetime.Token);
            try
            {
                if (session.Viewer is not null)
                {
                    throw new ApiException(409, "viewer_connected", "This session already has an active viewer.");
                }
                session.Viewer = relay;
                session.Interaction ??= new BrowserViewerInteraction(session, relay);
                session.Interaction.Attach(relay);
                var page = session.Pages[session.ActivePageId];
                await session.Interaction.ReplayAsync(page);
                await page.Page.StartScreencastAsync();
            }
            finally
            {
                session.Gate.Release();
            }
            await relay.RunAsync(socket, session.Interaction.HandleAsync, lifetime.Token);
        }
        finally
        {
            await session.Gate.WaitAsync(CancellationToken.None);
            try
            {
                if (session.Viewer == relay)
                {
                    session.Viewer = null;
                    foreach (var page in session.Pages.Values)
                    {
                        if (session.Interaction is { } interaction)
                        {
                            await interaction.ReleaseAsync(page, closePicker: false);
                        }
                        if (!page.Page.IsClosed)
                        {
                            try
                            {
                                await page.Page.StopScreencastAsync();
                            }
                            catch (CdpException) { }
                        }
                    }
                }
            }
            finally
            {
                session.Gate.Release();
            }
        }
    }

    public async Task CloseAsync(string sessionId)
    {
        if (!sessions.TryGetValue(sessionId, out var session))
        {
            return;
        }

        await session.Stop.CancelAsync();
        await session.Gate.WaitAsync(CancellationToken.None);
        try
        {
            await session.DisposeAsync();
            sessions.TryRemove(sessionId, out _);
        }
        finally
        {
            session.Gate.Release();
        }
    }

    public async Task ReapAsync(CancellationToken token)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
        while (await timer.WaitForNextTickAsync(token))
        {
            foreach (
                var session in sessions.Values.Where(s =>
                    s.Stop.IsCancellationRequested || s.LastSeen < DateTimeOffset.UtcNow.AddMinutes(-15)
                )
            )
            {
                await CloseAsync(session.Id);
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var id in sessions.Keys)
        {
            await CloseAsync(id);
        }
    }
}
