using System.Diagnostics;
using System.Text.Json;
using Microsoft.Playwright;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

internal sealed class BrowserPageCapture(BrowserPageRuntime page) : IAsyncDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly List<BrowserFrameCapture> frames = [];
    private bool complete;

    public async Task<CandidateCapture> CaptureAsync(string sessionId, string documentId, string captureId)
    {
        var timer = Stopwatch.StartNew();
        var candidates = new List<CandidateElement>();
        var scanned = 0;
        var eligible = 0;
        var unsupported = 0;
        string? error = null;
        var environment = await page.Page.EvaluateAsync<JsonElement>(
            "() => ({x:0,y:0,scaleX:1,scaleY:1,exposed:true,rendered:true,clip:{left:0,top:0,right:innerWidth,bottom:innerHeight}})"
        );
        await VisitAsync(page.Page.MainFrame, new TargetFrame("main", documentId, []), null, null, environment);
        if (timer.ElapsedMilliseconds >= 2000)
        {
            error = "capture_budget_exceeded";
        }
        complete = error is null;
        return new CandidateCapture(
            sessionId,
            page.Id,
            documentId,
            captureId,
            "main",
            DateTimeOffset.UtcNow,
            complete ? [.. candidates] : [],
            new CaptureCoverage(scanned, eligible, complete ? candidates.Count : 0, complete, error),
            unsupported
        );

        async Task VisitAsync(
            IFrame frame,
            TargetFrame identity,
            BrowserFrameCapture? parent,
            IElementHandle? owner,
            JsonElement environment
        )
        {
            if (error is not null)
            {
                return;
            }
            if (timer.ElapsedMilliseconds >= 2000 || frames.Count >= 64)
            {
                error = "capture_budget_exceeded";
                return;
            }
            var handle = await frame.EvaluateHandleAsync(
                BrowserCaptureScript.Capture,
                new
                {
                    sessionId,
                    pageId = page.Id,
                    documentId,
                    captureId,
                    frame = JsonSerializer.Serialize(identity, JsonOptions),
                    environment = environment.GetRawText(),
                    budgetMs = 2000 - timer.ElapsedMilliseconds,
                }
            );
            var captured = new BrowserFrameCapture(frame, handle, identity, parent, owner);
            frames.Add(captured);
            var data = await handle.EvaluateAsync<string>("capture => JSON.stringify(capture.data)");
            var result = JsonSerializer.Deserialize<CandidateCapture>(data, JsonOptions)!;
            scanned += result.Coverage.ScannedCount;
            eligible += result.Coverage.EligibleCount;
            unsupported += result.UnsupportedBoundaryCount;
            candidates.AddRange(result.Candidates);
            captured.CandidateIds.UnionWith(result.Candidates.Select(candidate => candidate.Id));
            if (
                !result.Coverage.Complete
                || scanned > 20000
                || eligible > 2000
                || JsonSerializer.SerializeToUtf8Bytes(candidates, JsonOptions).Length > 512000
                || timer.ElapsedMilliseconds >= 2000
            )
            {
                error = result.Coverage.ErrorCode ?? "capture_budget_exceeded";
                return;
            }
            var childCount = await handle.EvaluateAsync<int>("capture => capture.frameElements.length");
            for (var index = 0; index < childCount && error is null; index++)
            {
                if (timer.ElapsedMilliseconds >= 2000)
                {
                    error = "capture_budget_exceeded";
                    break;
                }
                var childHandle = await handle.EvaluateHandleAsync(
                    "(capture, index) => capture.frameElements[index]",
                    index
                );
                var element = childHandle.AsElement()!;
                var info = await handle.EvaluateAsync<JsonElement>(
                    "(capture, args) => capture.frameInfo(args.element, args.budgetMs)",
                    new { element, budgetMs = Math.Max(0, 2000 - timer.ElapsedMilliseconds) }
                );
                if (info.TryGetProperty("errorCode", out var helperError))
                {
                    error = helperError.GetString();
                    await childHandle.DisposeAsync();
                    break;
                }
                var child = await element.ContentFrameAsync();
                if (child is null || !info.GetProperty("environment").GetProperty("geometrySupported").GetBoolean())
                {
                    unsupported++;
                    await childHandle.DisposeAsync();
                    continue;
                }
                var id = $"f{frames.Count}";
                var chain = identity
                    .Chain.Append(
                        new FrameAncestor(
                            id,
                            info.GetProperty("xpath").GetString()!,
                            info.GetProperty("label").GetString()!
                        )
                    )
                    .ToArray();
                var before = frames.Count;
                try
                {
                    await VisitAsync(
                        child,
                        new TargetFrame(id, Guid.NewGuid().ToString("N"), chain),
                        captured,
                        element,
                        info.GetProperty("environment")
                    );
                }
                finally
                {
                    if (frames.Count == before)
                    {
                        await childHandle.DisposeAsync();
                    }
                }
            }
        }
    }

    public async Task<ActionSelectionValidation> SelectAsync(ActionSelection[] actions)
    {
        if (!complete)
        {
            throw new ApiException(409, "capture_budget_exceeded", "The capture is incomplete.");
        }
        var timer = Stopwatch.StartNew();
        foreach (var frame in frames)
        {
            CheckBudget(timer);
            await frame.RefreshAsync((int)(2000 - timer.ElapsedMilliseconds));
            await SelectFrameAsync(frame, null, "unsupported", timer);
        }
        var validated = new List<ValidatedAction>();
        foreach (var action in actions)
        {
            var frame = action.CandidateId is null
                ? frames[0]
                : frames.FirstOrDefault(frame => frame.CandidateIds.Contains(action.CandidateId))
                    ?? throw new ApiException(409, "unknown_candidate", "The target is outside this capture.");
            var selection = await SelectFrameAsync(frame, action.CandidateId, action.Action, timer);
            var target = selection.Target;
            if (target?.Interactability is { Checks.PointerReception: "pass" } assessment)
            {
                var point = await frame.Handle.EvaluateAsync<JsonElement>(
                    "(capture, args) => capture.point(args.id, args.budgetMs)",
                    new { id = action.CandidateId, budgetMs = Math.Max(0, 2000 - timer.ElapsedMilliseconds) }
                );
                if (point.TryGetProperty("errorCode", out _))
                {
                    throw new ApiException(
                        409,
                        "validation_budget_exceeded",
                        "Pointer observation exceeded its processing budget."
                    );
                }
                for (var current = frame; current.Parent is not null; current = current.Parent)
                {
                    var receives = await current.Parent.Handle.EvaluateAsync<bool>(
                        "(capture, args) => capture.receivesPoint(args.owner, JSON.parse(args.point), args.budgetMs)",
                        new
                        {
                            owner = current.Owner,
                            point = point.GetRawText(),
                            budgetMs = Math.Max(0, 2000 - timer.ElapsedMilliseconds),
                        }
                    );
                    if (!receives)
                    {
                        target = target with
                        {
                            Interactability = assessment with
                            {
                                Status = "blocked",
                                Reasons = [.. assessment.Reasons, "ancestor_frame_obstructed"],
                                Checks = assessment.Checks with { PointerReception = "fail" },
                            },
                        };
                        break;
                    }
                }
            }
            validated.Add(new ValidatedAction(action.ActionId, target));
        }
        CheckBudget(timer);
        return new ActionSelectionValidation(
            [.. validated],
            validated.FirstOrDefault(action => action.Target is not null)?.ActionId
        );
    }

    private static void CheckBudget(Stopwatch timer)
    {
        if (timer.ElapsedMilliseconds >= 2000)
        {
            throw new ApiException(
                409,
                "validation_budget_exceeded",
                "Target validation exceeded its processing budget."
            );
        }
    }

    private static async Task<SelectionValidation> SelectFrameAsync(
        BrowserFrameCapture frame,
        string? id,
        string action,
        Stopwatch timer
    )
    {
        CheckBudget(timer);
        var result = await frame.Handle.EvaluateAsync<JsonElement>(
            "(capture, args) => capture.select(args.id, args.action, args.budgetMs)",
            new
            {
                id,
                action,
                budgetMs = 2000 - timer.ElapsedMilliseconds,
            }
        );
        if (result.TryGetProperty("errorCode", out var code))
        {
            throw new ApiException(409, code.GetString()!, "The selected target is no longer valid in this capture.");
        }
        return result.Deserialize<SelectionValidation>(JsonOptions)!;
    }

    public async Task HighlightAsync(ResolvedTarget target)
    {
        var frame = frames.Single(frame => frame.CandidateIds.Contains(target.CandidateId));
        await PrepareHighlightAsync(frame);
        var resolved = await frame.Highlight!.SendAsync(
            "Runtime.evaluate",
            new Dictionary<string, object>
            {
                ["contextId"] = frame.ContextId!.Value,
                ["expression"] =
                    "(() => { const nodes = document.evaluate("
                    + JsonSerializer.Serialize(target.Xpaths[0])
                    + ", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); return nodes.snapshotLength === 1 ? nodes.snapshotItem(0) : null; })()",
            }
        );
        if (!resolved!.Value.GetProperty("result").TryGetProperty("objectId", out var objectId))
        {
            throw new ApiException(409, "stale_capture", "The target is no longer available to highlight.");
        }
        try
        {
            var current = await SelectAsync([
                new ActionSelection("highlight", target.CandidateId, target.Interactability!.Action),
            ]);
            if (current.Actions[0].Target?.Xpaths[0] != target.Xpaths[0])
            {
                throw new ApiException(409, "stale_capture", "The selected target changed before highlighting.");
            }
            await frame.Highlight.SendAsync(
                "Overlay.highlightNode",
                new Dictionary<string, object>
                {
                    ["objectId"] = objectId.GetString()!,
                    ["highlightConfig"] = new
                    {
                        showInfo = false,
                        contentColor = new
                        {
                            r = 59,
                            g = 130,
                            b = 246,
                            a = 0.18,
                        },
                        borderColor = new
                        {
                            r = 37,
                            g = 99,
                            b = 235,
                            a = 1,
                        },
                    },
                }
            );
        }
        finally
        {
            await frame.Highlight.SendAsync(
                "Runtime.releaseObject",
                new Dictionary<string, object> { ["objectId"] = objectId.GetString()! }
            );
        }
    }

    private async Task PrepareHighlightAsync(BrowserFrameCapture frame)
    {
        if (frame.ContextId is not null)
        {
            return;
        }
        string frameId;
        if (frame.Parent is null)
        {
            frame.Highlight = page.Highlight!;
            var tree = await frame.Highlight.SendAsync("Page.getFrameTree");
            frameId = tree!.Value.GetProperty("frameTree").GetProperty("frame").GetProperty("id").GetString()!;
        }
        else
        {
            await PrepareHighlightAsync(frame.Parent);
            var parentSession = frame.Parent.Highlight!;
            var owner = await parentSession.SendAsync(
                "Runtime.evaluate",
                new Dictionary<string, object>
                {
                    ["contextId"] = frame.Parent.ContextId!.Value,
                    ["expression"] =
                        "document.evaluate("
                        + JsonSerializer.Serialize(frame.Identity.Chain[^1].Xpath)
                        + ",document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue",
                }
            );
            var objectId = owner!.Value.GetProperty("result").GetProperty("objectId").GetString()!;
            try
            {
                var node = await parentSession.SendAsync(
                    "DOM.describeNode",
                    new Dictionary<string, object> { ["objectId"] = objectId }
                );
                frameId = node!.Value.GetProperty("node").GetProperty("frameId").GetString()!;
            }
            finally
            {
                await parentSession.SendAsync(
                    "Runtime.releaseObject",
                    new Dictionary<string, object> { ["objectId"] = objectId }
                );
            }
            try
            {
                frame.Highlight = await page.Page.Context.NewCDPSessionAsync(frame.Frame);
                await frame.Highlight.SendAsync("DOM.enable");
                await frame.Highlight.SendAsync("Overlay.enable");
            }
            catch (PlaywrightException error)
                when (error.Message.Contains("does not have a separate CDP session", StringComparison.Ordinal))
            {
                frame.Highlight = parentSession;
            }
        }
        var world = await frame.Highlight!.SendAsync(
            "Page.createIsolatedWorld",
            new Dictionary<string, object> { ["frameId"] = frameId, ["worldName"] = "xpathed-highlight" }
        );
        frame.ContextId = world!.Value.GetProperty("executionContextId").GetInt32();
    }

    public async Task ClearHighlightAsync()
    {
        foreach (var session in frames.Select(frame => frame.Highlight).OfType<ICDPSession>().Distinct())
        {
            try
            {
                await session.SendAsync("Overlay.hideHighlight");
            }
            catch (PlaywrightException) { }
        }
    }

    public async ValueTask DisposeAsync()
    {
        await ClearHighlightAsync();
        foreach (var frame in frames)
        {
            try
            {
                await frame.Handle.DisposeAsync();
                if (frame.Owner is not null)
                {
                    await frame.Owner.DisposeAsync();
                }
            }
            catch (PlaywrightException) { }
        }
        foreach (
            var session in frames
                .Select(frame => frame.Highlight)
                .OfType<ICDPSession>()
                .Distinct()
                .Where(session => session != page.Highlight)
        )
        {
            try
            {
                await session.DetachAsync();
            }
            catch (PlaywrightException) { }
        }
    }
}
