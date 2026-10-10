using System.Buffers.Binary;
using System.Diagnostics;
using System.Text.Json;
using Xpathed.Browser.Protocol;
using Xpathed.Browser.Scripts;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

internal sealed partial class BrowserPageCapture
{
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
}
