using System.Text.Json;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Resolver.Services;

public sealed class XPathSelectionService(IHttpClientFactory clients)
{
    public async Task<ActionSelectionValidation> SelectAsync(
        string pageId,
        ActionSelectionRequest request,
        CancellationToken cancellationToken
    )
    {
        if (request.Actions.Any(action => action is null))
        {
            throw new ApiException(400, "invalid_actions", "Every selected action must have an action record.");
        }
        using var browser = clients.CreateClient("browser");
        var candidateIds = request
            .Actions.Select(action => action.CandidateId)
            .OfType<string>()
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        XPathEvidenceBatch? evidence = null;
        XPathProposalSet[] proposals = [];
        if (candidateIds.Length != 0)
        {
            using var evidenceResponse = await browser.PostAsJsonAsync(
                $"/pages/{Uri.EscapeDataString(pageId)}/xpath-evidence",
                new XPathEvidenceRequest(request.DocumentId, request.CaptureId, candidateIds),
                cancellationToken
            );
            await BrowserResponse.EnsureSuccessAsync(evidenceResponse, cancellationToken);
            evidence = await ReadAsync<XPathEvidenceBatch>(
                evidenceResponse,
                "invalid_xpath_evidence",
                cancellationToken
            );
            proposals = XPathGenerator.Generate(evidence, candidateIds);
            ValidateContexts(evidence, request.DocumentId);
        }
        using var response = await browser.PostAsJsonAsync(
            $"/pages/{Uri.EscapeDataString(pageId)}/selections",
            request with
            {
                XpathProposals = proposals,
                XpathEvidenceId = evidence?.EvidenceId,
            },
            cancellationToken
        );
        await BrowserResponse.EnsureSuccessAsync(response, cancellationToken);
        var result = await ReadAsync<ActionSelectionValidation>(
            response,
            "invalid_browser_selection",
            cancellationToken
        );
        ValidateResult(request.Actions, evidence, proposals, result);
        return result!;
    }

    private static void ValidateResult(
        ActionSelection[] actions,
        XPathEvidenceBatch? evidence,
        XPathProposalSet[] proposals,
        ActionSelectionValidation? result
    )
    {
        if (result?.Actions is null || result.Actions.Length != actions.Length)
        {
            throw InvalidResult();
        }

        var byNode = proposals.ToDictionary(set => set.NodeId, StringComparer.Ordinal);
        bool Proposed(string? nodeId, string? xpath) =>
            nodeId is not null
            && xpath is not null
            && byNode.TryGetValue(nodeId, out var set)
            && set.Proposals.Any(proposal => proposal.Expression == xpath);
        bool Hosts(ShadowHost[]? actual, ShadowHost[]? expected) =>
            (actual ?? []).Length == (expected ?? []).Length
            && (actual ?? [])
                .Zip(expected ?? [])
                .All(pair =>
                    pair.First is not null
                    && pair.Second is not null
                    && pair.First.NodeId == pair.Second.NodeId
                    && pair.First.Label == pair.Second.Label
                    && Proposed(pair.First.NodeId, pair.First.Xpath)
                );
        bool Frame(TargetFrame? actual, TargetFrame? expected) =>
            actual is null
                ? expected is null
                : expected is not null
                    && actual.Id == expected.Id
                    && actual.DocumentId == expected.DocumentId
                    && actual.Chain is not null
                    && actual.Chain.Length == expected.Chain.Length
                    && actual
                        .Chain.Zip(expected.Chain)
                        .All(pair =>
                            pair.First is not null
                            && pair.Second is not null
                            && pair.First.FrameId == pair.Second.FrameId
                            && pair.First.NodeId == pair.Second.NodeId
                            && pair.First.Label == pair.Second.Label
                            && Proposed(pair.First.NodeId, pair.First.Xpath)
                            && Hosts(pair.First.ShadowChain, pair.Second.ShadowChain)
                        );
        for (var index = 0; index < actions.Length; index++)
        {
            var action = actions[index];
            var verified = result.Actions[index];
            if (verified is null || verified.ActionId != action.ActionId)
            {
                throw InvalidResult();
            }

            if (action.CandidateId is null)
            {
                if (verified.Target is not null)
                {
                    throw InvalidResult();
                }

                continue;
            }
            var expected = evidence!.Targets.Single(item => item.CandidateId == action.CandidateId);
            var target = verified.Target;
            if (
                target is null
                || target.CandidateId != action.CandidateId
                || target.Xpaths is not { Length: 1 }
                || !Proposed(expected.NodeId, target.Xpaths[0])
                || !Hosts(target.ShadowChain, expected.ShadowChain)
                || !Frame(target.Frame, expected.Frame)
                || target.State is null
                || target.Geometry is null
                || !BrowserEvidence.ValidInteractability(target, action.Action)
            )
            {
                throw InvalidResult();
            }
        }
        if (result.InspectedActionId != result.Actions.FirstOrDefault(action => action.Target is not null)?.ActionId)
        {
            throw InvalidResult();
        }
    }

    private static void ValidateContexts(XPathEvidenceBatch evidence, string documentId)
    {
        var nodes = evidence.Nodes.ToDictionary(node => node.NodeId, StringComparer.Ordinal);
        bool Known(string? id) => id is not null && evidence.TargetNodeIds.Contains(id, StringComparer.Ordinal);
        bool Hosts(ShadowHost[]? chain) =>
            chain is null
            || chain.All(host => host is not null && Known(host.NodeId) && host.Label is not null)
                && chain.Select(host => host.NodeId).Distinct(StringComparer.Ordinal).Count() == chain.Length;
        foreach (var target in evidence.Targets)
        {
            var frame = target.Frame;
            if (
                !Hosts(target.ShadowChain)
                || frame is not null
                    && (
                        string.IsNullOrWhiteSpace(frame.Id)
                        || string.IsNullOrWhiteSpace(frame.DocumentId)
                        || frame.Chain is null
                        || (
                            frame.Id == "main"
                                ? frame.DocumentId != documentId || frame.Chain.Length != 0
                                : frame.Chain.Length == 0 || frame.Chain[^1]?.FrameId != frame.Id
                        )
                        || frame.Chain.Any(ancestor =>
                            ancestor is null
                            || string.IsNullOrWhiteSpace(ancestor.FrameId)
                            || !Known(ancestor.NodeId)
                            || ancestor.Label is null
                            || !Hosts(ancestor.ShadowChain)
                            || !(ancestor.ShadowChain ?? [])
                                .Select(host => host.NodeId)
                                .SequenceEqual(nodes[ancestor.NodeId!].ShadowHostIds)
                        )
                        || frame.Chain.Select(ancestor => ancestor.FrameId).Distinct(StringComparer.Ordinal).Count()
                            != frame.Chain.Length
                        || frame.Chain.Select(ancestor => ancestor.NodeId).Distinct(StringComparer.Ordinal).Count()
                            != frame.Chain.Length
                    )
            )
            {
                throw new ApiException(
                    502,
                    "invalid_xpath_evidence",
                    "The browser returned inconsistent XPath context identities."
                );
            }
        }
    }

    private static ApiException InvalidResult() =>
        new(502, "invalid_browser_selection", "The browser did not verify the proposed XPath expressions.");

    private static async Task<T> ReadAsync<T>(
        HttpResponseMessage response,
        string code,
        CancellationToken cancellationToken
    )
        where T : class
    {
        try
        {
            return await response.Content.ReadFromJsonAsync<T>(cancellationToken)
                ?? throw new ApiException(502, code, "The browser returned no XPath evidence or verification.");
        }
        catch (JsonException)
        {
            throw new ApiException(502, code, "The browser returned invalid XPath evidence or verification.");
        }
    }
}
