using Xpathed.Common.Contracts;
using Xpathed.Common.Http;
using Xpathed.Resolver.Services;

namespace Xpathed.Resolver.Tests;

public sealed class XPathGeneratorTests
{
    [Fact]
    public void TargetTestContractsPrecedeTextAndOrdinaryIdentifiers()
    {
        var target = Node("target", "button") with
        {
            CandidateId = "selected",
            Text = "Save",
            Attributes = new()
            {
                ["data-testid"] = "save",
                ["id"] = "ordinary",
                ["aria-label"] = "Save",
            },
        };
        var proposals = Generate(target);
        Assert.Equal("//*[@data-testid='save']", proposals[0].Expression);
        Assert.True(
            Array.FindIndex(proposals, item => item.Expression == "//button[@aria-label='Save']")
                < Array.FindIndex(proposals, item => item.Expression == "//button[@id='ordinary']")
        );
    }

    [Fact]
    public void AncestorTestContractRequiresThatExactAncestorToBeUnique()
    {
        var parent = Node("parent", "section") with { Attributes = new() { ["data-testid"] = "profile" } };
        var target = Node("target", "button") with
        {
            CandidateId = "selected",
            ParentId = parent.NodeId,
            Text = "Save",
        };
        var first = Generate(target, parent)[0];
        Assert.Equal("//*[@data-testid='profile']//button", first.Expression);
        Assert.Equal(new XPathRequirement("parent", "//*[@data-testid='profile']"), Assert.Single(first.Requirements));
    }

    [Fact]
    public void ScopedHeadingsPrecedeAnOrdinaryTargetIdentifier()
    {
        var heading = TextNode("heading", "h2", "Billing");
        var parent = Node("parent", "section") with { HeadingId = heading.NodeId };
        var target = TextNode("target", "button", "Save") with
        {
            CandidateId = "selected",
            ParentId = parent.NodeId,
            Attributes = new() { ["id"] = "save" },
        };
        var expressions = Generate(target, parent, heading).Select(proposal => proposal.Expression).ToArray();
        Assert.True(
            Array.IndexOf(
                expressions,
                "//section[.//h2[normalize-space(.)='Billing']]//button[normalize-space(.)='Save']"
            ) < Array.IndexOf(expressions, "//button[@id='save']")
        );
    }

    [Fact]
    public void WrappingNativeLabelPrecedesOrdinaryIdentifiersButNotTestContracts()
    {
        var label = TextNode("label", "label", "Country");
        var wrapper = Node("wrapper", "span") with { ParentId = label.NodeId };
        var target = Node("target", "input") with
        {
            CandidateId = "selected",
            ParentId = wrapper.NodeId,
            LabelIds = [label.NodeId],
            Attributes = new() { ["id"] = "ordinary", ["data-testid"] = "country" },
        };
        var expressions = Generate(target, wrapper, label).Select(proposal => proposal.Expression).ToArray();
        Assert.Equal("//*[@data-testid='country']", expressions[0]);
        var labelled = Array.IndexOf(expressions, "//label[normalize-space(.)='Country']//input");
        Assert.True(labelled > 0);
        Assert.True(labelled < Array.IndexOf(expressions, "//input[@id='ordinary']"));
    }

    [Theory]
    [InlineData("x:control")]
    [InlineData("x$control")]
    [InlineData("é-control")]
    public void UnusualHtmlNamesUseNamespaceQualifiedNodeTests(string tag)
    {
        var target = TextNode("target", tag, "Save") with { CandidateId = "selected" };
        Assert.Equal(
            $"//*[local-name()='{tag}' and namespace-uri()='http://www.w3.org/1999/xhtml'][normalize-space(.)='Save']",
            Generate(target)[0].Expression
        );
    }

    [Fact]
    public void OrdinaryCustomElementsKeepConciseNodeTests()
    {
        var target = TextNode("target", "save-button", "Save") with { CandidateId = "selected" };
        Assert.Equal("//save-button[normalize-space(.)='Save']", Generate(target)[0].Expression);
    }

    [Fact]
    public void ExcludedTextUsesOnlySuppliedSafeFragmentsAndTheirOriginalPositions()
    {
        var target = Node("target", "button") with
        {
            CandidateId = "selected",
            Text = "Save now",
            TextFragments = [new(1, "Save"), new(3, " now")],
            TextNodeCount = 3,
            ExcludedText = true,
        };
        Assert.Contains(
            Generate(target),
            proposal =>
                proposal.Expression
                == "//button[count(descendant::text()[normalize-space(.)!=''])=3 and descendant::text()[normalize-space(.)!=''][1][normalize-space(.)='Save'] and descendant::text()[normalize-space(.)!=''][3][normalize-space(.)='now']]"
        );
    }

    [Fact]
    public void AccessibleNameSubstitutionDoesNotInventDomTextPredicates()
    {
        var target = TextNode("target", "button", "Visible DOM") with
        {
            CandidateId = "selected",
            Text = "Accessible name",
        };
        var expressions = Generate(target).Select(proposal => proposal.Expression).ToArray();
        Assert.Contains("//button[normalize-space(.)='Accessible name']", expressions);
        Assert.DoesNotContain(expressions, expression => expression.Contains("Visible DOM", StringComparison.Ordinal));
    }

    [Fact]
    public void XmlWhitespaceAndDisplayWhitespaceStayDistinct()
    {
        var target = Node("target", "button") with
        {
            CandidateId = "selected",
            Text = "Save now",
            TextFragments = [new(1, "Save\u00a0now")],
            TextNodeCount = 1,
        };
        var expressions = Generate(target).Select(proposal => proposal.Expression).ToArray();
        Assert.Contains("//button[normalize-space(.)='Save now']", expressions);
        Assert.Contains("//button[normalize-space(.)='Save\u00a0now']", expressions);
    }

    [Fact]
    public void LargeExcludedTextPreservesTheBoundOnFragmentPredicates()
    {
        var target = Node("target", "button") with
        {
            CandidateId = "selected",
            Text = "Save now",
            TextFragments = [new(1, "Save"), new(3, " now")],
            TextNodeCount = 3,
            MaximumTextLength = 64001,
            ExcludedText = true,
        };
        var expressions = Generate(target).Select(proposal => proposal.Expression).ToArray();
        Assert.Contains("//button[normalize-space(.)='Save now']", expressions);
        Assert.DoesNotContain(
            expressions,
            expression => expression.Contains("descendant::text()", StringComparison.Ordinal)
        );
    }

    [Fact]
    public void NamespacedFallbackUsesTreeLocalSiblingPositions()
    {
        var parent = Node("parent", "svg") with { NamespaceUri = "http://www.w3.org/2000/svg" };
        var target = Node("target", "rect") with
        {
            CandidateId = "selected",
            NamespaceUri = parent.NamespaceUri,
            ParentId = parent.NodeId,
            SiblingIndex = 2,
            SiblingCount = 3,
        };
        Assert.Equal(
            "/*[local-name()='svg' and namespace-uri()='http://www.w3.org/2000/svg']/*[local-name()='rect' and namespace-uri()='http://www.w3.org/2000/svg'][2]",
            Generate(target, parent)[^1].Expression
        );
    }

    [Fact]
    public void ShadowHostsReceiveIndependentOrderedProposals()
    {
        var host = Node("host", "custom-panel") with { Attributes = new() { ["data-testid"] = "panel" } };
        var target = TextNode("target", "button", "Save") with
        {
            CandidateId = "selected",
            ShadowHostIds = [host.NodeId],
        };
        var result = XPathGenerator.Generate(
            new("evidence", [target, host], [target.NodeId, host.NodeId], [Target(target)]),
            ["selected"]
        );
        Assert.Equal("//*[@data-testid='panel']", result.Single(set => set.NodeId == "host").Proposals[0].Expression);
        Assert.Equal(
            "//button[normalize-space(.)='Save']",
            result.Single(set => set.NodeId == "target").Proposals[0].Expression
        );
    }

    [Fact]
    public void CyclicEvidenceIsRejectedBeforeGeneratingProposals()
    {
        var target = Node("target", "button") with { CandidateId = "selected", ParentId = "target" };
        Assert.Equal("invalid_xpath_evidence", Assert.Throws<ApiException>(() => Generate(target)).Code);
    }

    [Theory]
    [InlineData("self")]
    [InlineData("repeated")]
    [InlineData("reordered")]
    [InlineData("parent-root")]
    public void InconsistentShadowDependenciesAreRejected(string defect)
    {
        var outer = Node("outer", "outer-panel");
        var inner = Node("inner", "inner-panel") with { ShadowHostIds = ["outer"] };
        var parent = Node("parent", "section");
        var target = Node("target", "button") with
        {
            CandidateId = "selected",
            ParentId = defect == "parent-root" ? "parent" : null,
            ShadowHostIds = defect switch
            {
                "self" => ["target"],
                "repeated" => ["outer", "outer"],
                "reordered" => ["inner", "outer"],
                _ => ["outer"],
            },
        };
        var evidence = new XPathEvidenceBatch(
            "evidence",
            [target, parent, outer, inner],
            ["target", "outer", "inner"],
            [Target(target)]
        );
        Assert.Equal(
            "invalid_xpath_evidence",
            Assert.Throws<ApiException>(() => XPathGenerator.Generate(evidence, ["selected"])).Code
        );
    }

    [Theory]
    [InlineData("Save", "'Save'")]
    [InlineData("User's", "\"User's\"")]
    [InlineData("User's \"Save\"", "concat('User',\"'\",'s \"Save\"')")]
    public void LiteralsPreserveBothQuoteKinds(string value, string expected) =>
        Assert.Equal(expected, XPathGenerator.Literal(value));

    private static XPathProposal[] Generate(XPathNodeEvidence target, params XPathNodeEvidence[] context) =>
        XPathGenerator
            .Generate(new("evidence", [target, .. context], [target.NodeId], [Target(target)]), ["selected"])[0]
            .Proposals;

    private static XPathTargetEvidence Target(XPathNodeEvidence target) =>
        new(
            "selected",
            target.NodeId,
            null,
            target.ShadowHostIds.Length == 0
                ? null
                : target.ShadowHostIds.Select(id => new ShadowHost("", "", id)).ToArray()
        );

    private static XPathNodeEvidence TextNode(string id, string tag, string text) =>
        Node(id, tag) with
        {
            Text = text,
            TextFragments = [new(1, text)],
            TextNodeCount = 1,
        };

    private static XPathNodeEvidence Node(string id, string tag) =>
        new(id, null, tag, "http://www.w3.org/1999/xhtml", [], "", [], 0, false, null, 1, 1, null, [], [], []);
}
