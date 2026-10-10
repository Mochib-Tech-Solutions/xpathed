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
}
