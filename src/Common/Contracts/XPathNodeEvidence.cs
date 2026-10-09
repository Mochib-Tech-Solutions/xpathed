namespace Xpathed.Common.Contracts;

public sealed record XPathNodeEvidence(
    string NodeId,
    string? CandidateId,
    string Tag,
    string NamespaceUri,
    Dictionary<string, string> Attributes,
    string Text,
    XPathTextFragment[] TextFragments,
    int TextNodeCount,
    bool ExcludedText,
    string? ParentId,
    int SiblingIndex,
    int SiblingCount,
    string? HeadingId,
    string[] CellIds,
    string[] LabelIds,
    string[] ShadowHostIds,
    int MaximumTextLength = 0
);
