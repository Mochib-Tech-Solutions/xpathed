using Xpathed.Common.Http;
using Xpathed.Resolver.Services;

namespace Xpathed.Resolver.Tests;

public sealed class ActionSelectionStrategyTests
{
    [Theory]
    [InlineData(
        """{"complete":true,"actions":[{"step":1,"instruction":"Click the button showing a blue triangle.","outcome":"unsupported","action":"click","candidateId":null,"limitation":"appearance_unavailable"}]}"""
    )]
    [InlineData(
        """{"complete":true,"actions":[{"step":1,"instruction":"Click the button showing a blue triangle in Secondary controls.","outcome":"unsupported","action":"click","candidateId":null,"limitation":"appearance_unavailable"}]}"""
    )]
    public void ValidEvidenceAbstentionPreservesItsReasonWithoutAnExecutableAction(string content)
    {
        foreach (var limitation in new[] { "appearance_unavailable", "state_unavailable", "target_not_addressable" })
        {
            var selection = Assert.Single(
                ActionSelectionStrategy.Select(
                    content.Replace("appearance_unavailable", limitation, StringComparison.Ordinal),
                    ["main:c4", "main:c8"]
                )
            );
            Assert.Equal("unsupported", selection.Outcome);
            Assert.Equal("unsupported", selection.Action);
            Assert.Equal(limitation, selection.Limitation);
            Assert.Null(selection.CandidateId);
        }
    }

    [Theory]
    [InlineData(
        """{"complete":true,"actions":[{"step":1,"instruction":"Click the triangle","outcome":"unsupported","action":"invented","candidateId":null,"limitation":"appearance_unavailable"}]}"""
    )]
    [InlineData(
        """{"complete":true,"actions":[{"step":1,"instruction":"Click the triangle","outcome":"unsupported","action":"click","candidateId":"main:c4","limitation":"appearance_unavailable"}]}"""
    )]
    [InlineData(
        """{"complete":true,"actions":[{"step":1,"instruction":"Click the triangle","outcome":"unsupported","action":"click","candidateId":"","limitation":"appearance_unavailable"}]}"""
    )]
    [InlineData(
        """{"complete":true,"actions":[{"step":1,"instruction":"Click the triangle","outcome":"found","action":"click","candidateId":"main:c4","limitation":"appearance_unavailable"}]}"""
    )]
    [InlineData(
        """{"complete":true,"actions":[{"step":1,"instruction":"Click the triangle","outcome":"unsupported","action":"click","candidateId":null,"limitation":"appearance_unavailable"},{"step":2,"instruction":"Click Save","outcome":"found","action":"click","candidateId":"main:c4","limitation":"none"}]}"""
    )]
    [InlineData(
        """{"complete":true,"actions":[{"step":1,"instruction":"Click the first triangle","outcome":"unsupported","action":"click","candidateId":null,"limitation":"appearance_unavailable"},{"step":2,"instruction":"Click the second triangle","outcome":"unsupported","action":"click","candidateId":null,"limitation":"appearance_unavailable"}]}"""
    )]
    public void EvidenceAbstentionDoesNotRepairInvalidOrMixedSelections(string content)
    {
        foreach (var limitation in new[] { "appearance_unavailable", "state_unavailable", "target_not_addressable" })
        {
            var error = Assert.Throws<ApiException>(() =>
                ActionSelectionStrategy.Select(
                    content.Replace("appearance_unavailable", limitation, StringComparison.Ordinal),
                    ["main:c4"]
                )
            );
            Assert.Equal("provider_malformed_response", error.Code);
        }
    }
}
