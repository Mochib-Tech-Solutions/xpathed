using System.Buffers.Binary;
using System.Diagnostics;
using System.Text.Json;
using Xpathed.Browser.Protocol;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

internal sealed class BrowserPageCapture(BrowserPageRuntime page) : IAsyncDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly List<BrowserFrameCapture> frames = [];
    private bool complete;
    private string? xpathEvidenceId;
    private readonly HashSet<BrowserFrameCapture> selectedFrames = [];
    private readonly HashSet<BrowserFrameCapture> xpathFrames = [];

    public bool UsesFrame(CdpFrame frame) => selectedFrames.Any(captured => captured.Frame == frame);

    public async Task<CaptureImage> CaptureImageAsync()
    {
        try
        {
            var png = await CdpScreenshot.CaptureAsync(page.Page);
            return new CaptureImage(
                png,
                BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(16, 4)),
                BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(20, 4))
            );
        }
        catch (CdpException)
        {
            throw new ApiException(
                409,
                "capture_image_unavailable",
                "The browser could not safely mask this screenshot. Closed or inaccessible page components may prevent image export; try without a screenshot."
            );
        }
    }

    public async Task<CandidateCapture> CaptureAsync(string sessionId, string documentId, string captureId)
    {
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
            CdpFrame frame,
            TargetFrame identity,
            BrowserFrameCapture? parent,
            CdpRemoteObject? owner,
            JsonElement environment
        )
        {
            if (error is not null)
            {
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
            if (!result.Coverage.Complete)
            {
                error = result.Coverage.ErrorCode ?? "capture_incomplete";
                return;
            }
            var childCount = await handle.EvaluateAsync<int>("capture => capture.frameElements.length");
            for (var index = 0; index < childCount && error is null; index++)
            {
                var childHandle = await handle.EvaluateHandleAsync(
                    "(capture, index) => capture.frameElements[index]",
                    index
                );
                var element = childHandle;
                var info = await handle.EvaluateAsync<JsonElement>(
                    "(capture, element) => capture.frameInfo(element)",
                    element
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
                                : null,
                            info.GetProperty("nodeId").GetString()
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

    public async Task<XPathEvidenceBatch> XPathEvidenceAsync(string[] candidateIds)
    {
        xpathEvidenceId = null;
        var evidenceId = Guid.NewGuid().ToString("N");
        HashSet<BrowserFrameCapture> selected = [];
        foreach (var candidateId in candidateIds)
        {
            var frame =
                frames.FirstOrDefault(frame => frame.CandidateIds.Contains(candidateId))
                ?? throw new ApiException(409, "unknown_candidate", "The target is outside this capture.");
            for (var current = frame; current is not null; current = current.Parent)
            {
                selected.Add(current);
            }
        }
        var timer = Stopwatch.StartNew();
        var nodes = new List<XPathNodeEvidence>();
        xpathFrames.Clear();
        xpathFrames.UnionWith(selected);
        var targets = new List<string>();
        var identities = new List<XPathTargetEvidence>();
        foreach (var frame in frames.Where(selected.Contains))
        {
            CheckBudget(timer);
            var owners = frames
                .Where(child => selected.Contains(child) && child.Parent == frame)
                .Select(child => child.Identity.Chain[^1].NodeId!)
                .ToArray();
            var result = await frame.Handle.EvaluateAsync<JsonElement>(
                "(capture,args) => capture.xpathEvidence(args.candidateIds,args.nodeIds,args.budgetMs)",
                new
                {
                    candidateIds = candidateIds.Where(frame.CandidateIds.Contains).ToArray(),
                    nodeIds = owners,
                    budgetMs = 2000 - timer.ElapsedMilliseconds,
                }
            );
            ThrowScriptError(result);
            var batch = result.Deserialize<XPathEvidenceBatch>(JsonOptions)!;
            nodes.AddRange(batch.Nodes);
            targets.AddRange(batch.TargetNodeIds);
            identities.AddRange(batch.Targets);
        }
        CheckBudget(timer);
        xpathEvidenceId = evidenceId;
        return new(
            evidenceId,
            nodes.DistinctBy(node => node.NodeId).ToArray(),
            targets.Distinct(StringComparer.Ordinal).ToArray(),
            identities.ToArray()
        );
    }

    public async Task VerifyXPathProposalsAsync(string? evidenceId, XPathProposalSet[] proposals)
    {
        if (evidenceId is null || evidenceId != xpathEvidenceId)
        {
            throw new ApiException(
                409,
                "stale_xpath_evidence",
                "The target evidence changed. Resolve the instruction again."
            );
        }
        if (
            proposals.Any(set =>
                set is null
                || string.IsNullOrEmpty(set.NodeId)
                || set.Proposals is null
                || set.Proposals.Length == 0
                || set.Proposals.Any(proposal =>
                    proposal is null
                    || string.IsNullOrWhiteSpace(proposal.Expression)
                    || proposal.Requirements is null
                    || proposal.Requirements.Any(requirement =>
                        requirement is null
                        || string.IsNullOrEmpty(requirement.NodeId)
                        || string.IsNullOrWhiteSpace(requirement.Expression)
                    )
                )
            )
            || proposals.Select(set => set.NodeId).Distinct(StringComparer.Ordinal).Count() != proposals.Length
        )
        {
            throw new ApiException(
                400,
                "invalid_xpath_proposals",
                "Supply ordered XPath proposals for each retained node."
            );
        }
        var timer = Stopwatch.StartNew();
        foreach (var frame in frames)
        {
            var sets = proposals
                .Where(set => set.NodeId.StartsWith(frame.Identity.Id + ":", StringComparison.Ordinal))
                .ToArray();
            if (sets.Length == 0)
            {
                continue;
            }
            CheckBudget(timer);
            var result = await frame.Handle.EvaluateAsync<JsonElement>(
                "(capture,args) => capture.verifyXpathProposals(args.sets,args.budgetMs)",
                new { sets, budgetMs = 2000 - timer.ElapsedMilliseconds }
            );
            ThrowScriptError(result);
        }
        if (
            proposals.Any(set =>
                !frames.Any(frame => set.NodeId.StartsWith(frame.Identity.Id + ":", StringComparison.Ordinal))
            )
        )
        {
            throw new ApiException(409, "unknown_candidate", "A proposal refers to a different capture.");
        }
        foreach (var frame in frames.Where(frame => xpathFrames.Contains(frame) && frame.Parent is not null))
        {
            var info = await frame.Parent!.Handle.EvaluateAsync<JsonElement>(
                "(capture,owner) => capture.frameInfo(owner)",
                frame.Owner
            );
            ThrowScriptError(info);
            var owner = new FrameAncestor(
                frame.Identity.Id,
                info.GetProperty("xpath").GetString()!,
                info.GetProperty("label").GetString()!,
                info.TryGetProperty("shadowChain", out var chain) ? chain.Deserialize<ShadowHost[]>(JsonOptions) : null,
                info.GetProperty("nodeId").GetString()
            );
            frame.Identity = frame.Identity with { Chain = [.. frame.Parent.Identity.Chain, owner] };
        }
    }

    private static void ThrowScriptError(JsonElement result)
    {
        if (result.TryGetProperty("errorCode", out var code))
        {
            throw new ApiException(409, code.GetString()!, "The retained target could not be verified.");
        }
    }

    public async Task<bool> XPathPrivacyUnchangedAsync()
    {
        try
        {
            foreach (var frame in xpathFrames)
            {
                if (
                    frame.Frame.IsDetached
                    || !await frame.Handle.EvaluateAsync<bool>("capture => capture.xpathPrivacyUnchanged()")
                )
                {
                    return false;
                }
            }
            return true;
        }
        catch (CdpException)
        {
            return false;
        }
    }

    public async Task<bool> PrivacyUnchangedAsync()
    {
        try
        {
            foreach (var frame in frames)
            {
                if (
                    frame.Frame.IsDetached
                    || !await frame.Handle.EvaluateAsync<bool>("capture => capture.privacyUnchanged()")
                )
                {
                    return false;
                }
            }
            return true;
        }
        catch (CdpException)
        {
            return false;
        }
    }

    public async Task<ActionSelectionValidation> SelectAsync(ActionSelection[] actions)
    {
        if (!complete)
        {
            throw new ApiException(409, "capture_incomplete", "The capture is incomplete.");
        }
        var timer = Stopwatch.StartNew();
        HashSet<BrowserFrameCapture> framesToRefresh = [frames[0]];
        foreach (var action in actions.Where(action => action.CandidateId is not null))
        {
            var frame =
                frames.FirstOrDefault(frame => frame.CandidateIds.Contains(action.CandidateId!))
                ?? throw new ApiException(409, "unknown_candidate", "The target is outside this capture.");
            for (var current = frame; current is not null; current = current.Parent)
            {
                framesToRefresh.Add(current);
            }
        }
        selectedFrames.UnionWith(framesToRefresh);
        foreach (var frame in frames.Where(framesToRefresh.Contains))
        {
            CheckBudget(timer);
            var ids = actions
                .Select(action => action.CandidateId)
                .OfType<string>()
                .Where(frame.CandidateIds.Contains)
                .ToArray();
            await frame.RefreshAsync((int)(2000 - timer.ElapsedMilliseconds), ids);
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
            if (target is not null)
            {
                target = target with { Frame = frame.Identity };
            }
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
                await highlight.EvaluateAsync(
                    "(overlay, selection) => overlay.spotlight(selection.index, selection.active)",
                    new { index, active = candidateId is not null }
                );
            }
        }
    }

    public async Task<CdpRemoteObject> RetainedTargetAsync(string candidateId)
    {
        var frame =
            frames.FirstOrDefault(frame => frame.CandidateIds.Contains(candidateId))
            ?? throw new ApiException(409, "unknown_candidate", "The target is outside this capture.");
        var handle = await frame.Handle.EvaluateHandleAsync(
            "(capture, id) => capture.highlightNodes([id])[0]",
            candidateId
        );
        return handle;
    }

    public async Task<JsonElement> TargetPointAsync(string candidateId)
    {
        var frame =
            frames.FirstOrDefault(frame => frame.CandidateIds.Contains(candidateId))
            ?? throw new ApiException(409, "unknown_candidate", "The target is outside this capture.");
        var point = await frame.Handle.EvaluateAsync<JsonElement>(
            "(capture,id) => capture.point(id,2000)",
            candidateId
        );
        ThrowScriptError(point);
        return point;
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
            catch (CdpException) { }
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
            catch (CdpException) { }
        }
    }
}
