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
        var excludedOffscreen = 0;
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
            new CaptureCoverage(scanned, eligible, complete ? candidates.Count : 0, complete, error, excludedOffscreen),
            unsupported,
            "current_view"
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
                    scope = "current_view",
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
            excludedOffscreen += result.Coverage.ExcludedOffscreenCount;
            unsupported += result.UnsupportedBoundaryCount;
            candidates.AddRange(result.Candidates);
            captured.CandidateIds.UnionWith(result.Candidates.Select(candidate => candidate.Id));
            captured.Candidates = result.Candidates;
            if (
                !result.Coverage.Complete
                || scanned > 20000
                || candidates.Count > 2000
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
                            info.GetProperty("label").GetString()!,
                            info.TryGetProperty("shadowChain", out var shadowChain)
                                ? shadowChain.Deserialize<ShadowHost[]>(JsonOptions)
                                : null
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

    public async Task<ActionSelectionValidation> SelectAsync(ActionSelection[] actions, SelectionRule? rule = null)
    {
        if (!complete)
        {
            throw new ApiException(409, "capture_budget_exceeded", "The capture is incomplete.");
        }
        var timer = Stopwatch.StartNew();
        var scanBudget = 20000;
        var expected = actions.Select(action => action.CandidateId).OfType<string>().ToHashSet(StringComparer.Ordinal);
        if (
            rule is not null
            && (
                !rule.IsValid
                || actions.Any(action => action.CandidateId is null)
                || expected.Count != actions.Length
                || !frames
                    .SelectMany(frame => frame.Candidates)
                    .Where(rule.Matches)
                    .Select(candidate => candidate.Id)
                    .ToHashSet(StringComparer.Ordinal)
                    .SetEquals(expected)
            )
        )
        {
            throw new ApiException(
                400,
                "invalid_selection_rule",
                "The matching rule must reproduce the complete captured target set."
            );
        }
        var fresh = new List<CandidateElement>();
        foreach (var frame in frames)
        {
            CheckBudget(timer);
            var observation = await frame.RefreshAsync(
                (int)(2000 - timer.ElapsedMilliseconds),
                scanBudget,
                rule is not null
            );
            scanBudget -= observation.ScannedCount;
            fresh.AddRange(observation.Candidates);
            if (fresh.Count > 2000 || JsonSerializer.SerializeToUtf8Bytes(fresh, JsonOptions).Length > 512000)
            {
                throw new ApiException(
                    409,
                    "validation_budget_exceeded",
                    "The complete matching-rule comparison exceeds its observation budget."
                );
            }
            await SelectFrameAsync(frame, null, "unsupported", timer);
        }
        if (
            rule is not null
            && !fresh
                .Where(rule.Matches)
                .Select(candidate => candidate.Id)
                .ToHashSet(StringComparer.Ordinal)
                .SetEquals(expected)
        )
        {
            throw new ApiException(409, "stale_capture", "The matching target set changed after capture.");
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

    public async Task HighlightAsync(ResolvedTarget[] targets)
    {
        foreach (var frame in frames)
        {
            var ids = targets
                .Where(target => frame.CandidateIds.Contains(target.CandidateId))
                .Select(target => target.CandidateId)
                .Distinct()
                .ToArray();
            if (ids.Length == 0)
            {
                continue;
            }
            frame.Highlight = await frame.Handle.EvaluateHandleAsync(
                "(capture, ids) => (" + BrowserHighlightScript.Create + ")(capture.highlightNodes(ids))",
                ids
            );
            frame.HighlightCandidateIds = ids;
        }
    }

    public async Task SpotlightAsync(string? candidateId)
    {
        foreach (var frame in frames)
        {
            if (frame.Highlight is { } highlight)
            {
                var index = candidateId is null ? -1 : Array.IndexOf(frame.HighlightCandidateIds, candidateId);
                await highlight.EvaluateAsync("(overlay, index) => overlay.spotlight(index)", index);
            }
        }
    }

    public async Task ClearHighlightAsync()
    {
        foreach (var frame in frames.ToArray())
        {
            var highlight = frame.Highlight;
            frame.Highlight = null;
            frame.HighlightCandidateIds = [];
            if (highlight is null)
            {
                continue;
            }
            try
            {
                await highlight.EvaluateAsync("overlay => overlay.clear()");
                await highlight.DisposeAsync();
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
    }
}
