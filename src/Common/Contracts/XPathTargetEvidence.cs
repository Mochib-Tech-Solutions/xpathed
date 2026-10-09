namespace Xpathed.Common.Contracts;

public sealed record XPathTargetEvidence(
    string CandidateId,
    string NodeId,
    TargetFrame? Frame,
    ShadowHost[]? ShadowChain
);
