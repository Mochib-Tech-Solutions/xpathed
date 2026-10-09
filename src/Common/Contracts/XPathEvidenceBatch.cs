namespace Xpathed.Common.Contracts;

public sealed record XPathEvidenceBatch(
    string EvidenceId,
    XPathNodeEvidence[] Nodes,
    string[] TargetNodeIds,
    XPathTargetEvidence[] Targets
);
