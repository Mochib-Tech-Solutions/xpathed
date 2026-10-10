using System.Text;
using System.Text.RegularExpressions;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Resolver.Services;

internal static partial class XPathGenerator
{
    private static readonly string[] TestAttributes =
    [
        "data-testid",
        "data-test-id",
        "data-test",
        "data-cy",
        "data-qa",
    ];
    private static readonly string[] StableAttributes = ["id", "name", "aria-label", "placeholder", "alt", "title"];
    private static readonly string[] SemanticAttributes = ["aria-label", "placeholder", "alt", "title"];

    internal static XPathProposalSet[] Generate(XPathEvidenceBatch evidence, string[] candidateIds)
    {
        var nodes = Validate(evidence, candidateIds);
        return evidence.TargetNodeIds.Select(id => new XPathProposalSet(id, Proposals(nodes[id], nodes))).ToArray();
    }

    private static Dictionary<string, XPathNodeEvidence> Validate(XPathEvidenceBatch evidence, string[] candidateIds)
    {
        if (
            evidence?.Nodes is null
            || evidence.TargetNodeIds is null
            || evidence.Targets is null
            || string.IsNullOrWhiteSpace(evidence.EvidenceId)
        )
        {
            throw InvalidEvidence();
        }
        var nodes = new Dictionary<string, XPathNodeEvidence>(StringComparer.Ordinal);
        foreach (var node in evidence.Nodes)
        {
            if (
                node is null
                || string.IsNullOrWhiteSpace(node.NodeId)
                || string.IsNullOrWhiteSpace(node.Tag)
                || node.NamespaceUri is null
                || node.Attributes is null
                || node.Attributes.Any(attribute => attribute.Value is null)
                || node.Text is null
                || node.TextFragments is null
                || node.TextNodeCount < 0
                || node.MaximumTextLength < 0
                || node.TextFragments.Any(fragment =>
                    fragment is null
                    || fragment.Text is null
                    || fragment.Index < 0
                    || fragment.Index > node.TextNodeCount
                )
                || node.CellIds is null
                || node.LabelIds is null
                || node.ShadowHostIds is null
                || node.SiblingIndex < 1
                || node.SiblingCount < node.SiblingIndex
                || !nodes.TryAdd(node.NodeId, node)
            )
            {
                throw InvalidEvidence();
            }
        }
        if (
            evidence.TargetNodeIds.Distinct(StringComparer.Ordinal).Count() != evidence.TargetNodeIds.Length
            || evidence.TargetNodeIds.Any(id => id is null || !nodes.ContainsKey(id))
            || candidateIds.Any(id => evidence.TargetNodeIds.Count(nodeId => nodes[nodeId].CandidateId == id) != 1)
            || evidence.Targets.Length != candidateIds.Length
            || evidence.Targets.Any(target =>
                target is null
                || !candidateIds.Contains(target.CandidateId, StringComparer.Ordinal)
                || string.IsNullOrWhiteSpace(target.NodeId)
                || !nodes.TryGetValue(target.NodeId, out var node)
                || node.CandidateId != target.CandidateId
                || target.ShadowChain?.Any(host => host is null) == true
                || !(target.ShadowChain ?? []).Select(host => host.NodeId).SequenceEqual(node.ShadowHostIds)
            )
            || evidence.Targets.Select(target => target.CandidateId).Distinct(StringComparer.Ordinal).Count()
                != candidateIds.Length
        )
        {
            throw InvalidEvidence();
        }
        foreach (var node in nodes.Values)
        {
            var references = node.CellIds.Concat(node.LabelIds).Concat(node.ShadowHostIds);
            if (node.HeadingId is { } heading)
            {
                references = references.Append(heading);
            }

            if (node.ParentId is { } parent)
            {
                references = references.Append(parent);
            }

            if (references.Any(id => id is null || !nodes.ContainsKey(id)))
            {
                throw InvalidEvidence();
            }

            var seen = new HashSet<string>(StringComparer.Ordinal) { node.NodeId };
            for (var current = node; current.ParentId is { } parentId; current = nodes[parentId])
            {
                if (!seen.Add(parentId))
                {
                    throw InvalidEvidence();
                }
            }
            if (node.ShadowHostIds.Any(id => !evidence.TargetNodeIds.Contains(id, StringComparer.Ordinal)))
            {
                throw InvalidEvidence();
            }
            if (
                node.ShadowHostIds.Contains(node.NodeId, StringComparer.Ordinal)
                || node.ShadowHostIds.Distinct(StringComparer.Ordinal).Count() != node.ShadowHostIds.Length
                || node.ShadowHostIds.Where(
                        (id, index) => !nodes[id].ShadowHostIds.SequenceEqual(node.ShadowHostIds.Take(index))
                    )
                    .Any()
                || node.ParentId is { } parentIdValue
                    && !nodes[parentIdValue].ShadowHostIds.SequenceEqual(node.ShadowHostIds)
            )
            {
                throw InvalidEvidence();
            }
        }
        return nodes;
    }

    private static XPathProposal[] Proposals(XPathNodeEvidence target, Dictionary<string, XPathNodeEvidence> nodes)
    {
        var result = new List<XPathProposal>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        void Add(string expression, XPathRequirement[]? requirements = null)
        {
            requirements ??= [];
            var identity =
                expression
                + "\0"
                + string.Join(
                    "\0",
                    requirements.Select(requirement => requirement.NodeId + "\0" + requirement.Expression)
                );
            if (seen.Add(identity))
            {
                result.Add(new XPathProposal(expression, requirements));
            }
        }
        var ancestors = Ancestors(target, nodes).ToArray();
        var test = Attributes(target, TestAttributes).ToArray();
        foreach (var predicate in test)
        {
            Add($"//*[{predicate}]");
        }

        foreach (var predicate in test)
        {
            Add($"//{Tag(target)}[{predicate}]");
        }

        foreach (var ancestor in ancestors)
        {
            foreach (var predicate in Attributes(ancestor, TestAttributes))
            {
                var prefix = $"//*[{predicate}]";
                XPathRequirement[] requirements = [new(ancestor.NodeId, prefix)];
                foreach (var targetPredicate in test)
                {
                    Add($"{prefix}//*[{targetPredicate}]", requirements);
                }

                Add($"{prefix}//{Tag(target)}", requirements);
            }
        }
        var stable = Attributes(target, StableAttributes).ToArray();
        var semantic = Attributes(target, SemanticAttributes).Concat(TextPredicates(target)).ToList();
        if (
            target.Tag == "input"
            && target.Attributes.GetValueOrDefault("type")?.ToLowerInvariant() is "button" or "submit" or "reset"
            && target.Attributes.TryGetValue("value", out var value)
            && value.Length != 0
        )
        {
            semantic.Add($"@value={Literal(value)}");
        }

        foreach (var ancestor in ancestors.TakeWhile(node => !IsBody(node)))
        {
            foreach (var prefix in ContextPrefixes(ancestor, nodes, false))
            {
                foreach (var predicate in test.Concat(semantic))
                {
                    Add($"{prefix}//{Tag(target)}[{predicate}]");
                }
            }
        }
        foreach (var labelId in target.LabelIds)
        {
            var label = nodes[labelId];
            if (ancestors.Any(ancestor => ancestor.NodeId == labelId))
            {
                foreach (var predicate in TextPredicates(label))
                {
                    Add($"//{Tag(label)}[{predicate}]//{Tag(target)}");
                }
            }
            if (target.Attributes.TryGetValue("id", out var id) && label.Attributes.GetValueOrDefault("for") == id)
            {
                foreach (var predicate in TextPredicates(label))
                {
                    Add($"//{Tag(target)}[@id=//label[{predicate}]/@for]");
                }
            }
        }
        foreach (var predicate in semantic)
        {
            Add($"//{Tag(target)}[{predicate}]");
        }

        foreach (var predicate in stable)
        {
            Add($"//{Tag(target)}[{predicate}]");
        }

        var targetPredicates = test.Concat(stable).ToArray();
        for (var first = 0; first < targetPredicates.Length; first++)
        {
            for (var second = first + 1; second < targetPredicates.Length; second++)
            {
                Add($"//{Tag(target)}[{targetPredicates[first]} and {targetPredicates[second]}]");
            }
        }
        foreach (var ancestor in ancestors.TakeWhile(node => !IsBody(node)))
        {
            foreach (var prefix in ContextPrefixes(ancestor, nodes, true))
            {
                foreach (var predicate in targetPredicates.Concat(semantic))
                {
                    Add($"{prefix}//{Tag(target)}[{predicate}]");
                }

                Add($"{prefix}//{Tag(target)}");
            }
        }
        var path = ancestors
            .Prepend(target)
            .Reverse()
            .Select(node => Tag(node) + (node.SiblingCount > 1 ? $"[{node.SiblingIndex}]" : ""));
        Add("/" + string.Join('/', path));
        return [.. result];
    }

    private static IEnumerable<XPathNodeEvidence> Ancestors(
        XPathNodeEvidence node,
        Dictionary<string, XPathNodeEvidence> nodes
    )
    {
        while (node.ParentId is { } parent)
        {
            node = nodes[parent];
            yield return node;
        }
    }

    private static IEnumerable<string> ContextPrefixes(
        XPathNodeEvidence node,
        Dictionary<string, XPathNodeEvidence> nodes,
        bool identifiers
    )
    {
        var predicates = Attributes(node, TestAttributes.Concat(["aria-label", "title"]));
        if (node.HeadingId is { } headingId)
        {
            var heading = nodes[headingId];
            predicates = predicates.Concat(
                TextPredicates(heading).Select(predicate => $".//{Tag(heading)}[{predicate}]")
            );
        }
        foreach (var cellId in node.CellIds)
        {
            var cell = nodes[cellId];
            predicates = predicates.Concat(TextPredicates(cell).Select(predicate => $"{Tag(cell)}[{predicate}]"));
        }
        if (identifiers)
        {
            predicates = predicates.Concat(Attributes(node, ["id", "name"]));
        }

        foreach (var predicate in predicates)
        {
            yield return $"//{Tag(node)}[{predicate}]";
        }

        if (node.Tag is "header" or "footer" or "nav" or "main" or "aside")
        {
            yield return $"//{Tag(node)}";
        }
    }

    private static IEnumerable<string> Attributes(XPathNodeEvidence node, IEnumerable<string> names) =>
        names
            .Where(name =>
                node.Attributes.TryGetValue(name, out var value)
                && value.Length != 0
                && !Url().IsMatch(value)
                && (name != "id" || !UnstableId().IsMatch(value))
            )
            .Select(name => $"@{name}={Literal(node.Attributes[name])}");

    private static IEnumerable<string> TextPredicates(XPathNodeEvidence node)
    {
        if (node.Text.Length == 0)
        {
            yield break;
        }

        yield return $"normalize-space(.)={Literal(node.Text)}";
        if (
            node.TextNodeCount > 16
            || node.MaximumTextLength > 64000
            || node.TextFragments.Any(fragment => fragment.Text.Length > 64000)
        )
        {
            yield break;
        }

        if (Normalize(string.Join(' ', node.TextFragments.Select(fragment => fragment.Text))) != node.Text)
        {
            yield break;
        }

        if (node.ExcludedText)
        {
            var fragments = node
                .TextFragments.Where(fragment => XmlNormalize(fragment.Text).Length != 0)
                .Select(fragment =>
                    $"descendant::text()[normalize-space(.)!=''][{fragment.Index}][normalize-space(.)={Literal(XmlNormalize(fragment.Text))}]"
                )
                .ToArray();
            if (fragments.Length != 0)
            {
                yield return $"count(descendant::text()[normalize-space(.)!=''])={node.TextNodeCount} and {string.Join(" and ", fragments)}";
            }
        }
        else
        {
            var joined = XmlNormalize(string.Concat(node.TextFragments.Select(fragment => fragment.Text)));
            if (joined.Length != 0 && joined != node.Text)
            {
                yield return $"normalize-space(.)={Literal(joined)}";
            }
        }
    }

    internal static string Literal(string value) =>
        !value.Contains('\'') ? $"'{value}'"
        : !value.Contains('"') ? $"\"{value}\""
        : "concat(" + string.Join(",\"'\",", value.Split('\'').Select(part => $"'{part}'")) + ")";

    private static string Tag(XPathNodeEvidence node) =>
        node.NamespaceUri == "http://www.w3.org/1999/xhtml" && SimpleTag().IsMatch(node.Tag)
            ? node.Tag
            : $"*[local-name()={Literal(node.Tag)} and namespace-uri()={Literal(node.NamespaceUri)}]";

    private static bool IsBody(XPathNodeEvidence node) =>
        node.Tag == "body" && node.NamespaceUri == "http://www.w3.org/1999/xhtml";

    private static string Normalize(string value) =>
        DisplayWhitespace().Replace(value, " ").Trim(' ').Normalize(NormalizationForm.FormC);

    private static string XmlNormalize(string value) => XmlWhitespace().Replace(value, " ").Trim(' ');

    private static ApiException InvalidEvidence() =>
        new(502, "invalid_xpath_evidence", "The browser returned inconsistent XPath evidence.");

    [GeneratedRegex("\\A[A-Za-z_][A-Za-z0-9_.-]*\\z", RegexOptions.CultureInvariant)]
    private static partial Regex SimpleTag();

    [GeneratedRegex("https?://", RegexOptions.CultureInvariant)]
    private static partial Regex Url();

    [GeneratedRegex(
        "(?:[a-f\\d]{16}|\\d{5}|^:|^\\d+$|[a-f\\d]{8}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{12})",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    )]
    private static partial Regex UnstableId();

    [GeneratedRegex(
        "[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+",
        RegexOptions.CultureInvariant
    )]
    private static partial Regex DisplayWhitespace();

    [GeneratedRegex("[ \\t\\r\\n]+", RegexOptions.CultureInvariant)]
    private static partial Regex XmlWhitespace();
}
