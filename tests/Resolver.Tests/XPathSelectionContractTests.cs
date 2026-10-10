using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xpathed.Common.Contracts;
using static Xpathed.Resolver.Tests.DeterministicServicesHandler;
using static Xpathed.Resolver.Tests.ResolverTestApplication;

namespace Xpathed.Resolver.Tests;

public sealed class XPathSelectionContractTests
{
    [Fact]
    public async Task CoreSelectionRejectsNullActionEntriesBeforeCallingBrowser()
    {
        var handler = new DeterministicServicesHandler();
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/selections",
            new
            {
                documentId = "document-1",
                captureId = "capture-1",
                actions = new object?[] { null },
            }
        );
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(0, handler.XPathEvidenceRequestCount);
        Assert.Equal(0, handler.SelectionRequestCount);
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"nodes\":[],\"targetNodeIds\":[],\"targets\":[]}")]
    [InlineData("{\"nodes\":")]
    public async Task CoreSelectionRejectsMalformedStructuralEvidenceBeforeVerification(string evidence)
    {
        var handler = new DeterministicServicesHandler { XPathEvidenceBody = evidence };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/selections",
            new
            {
                documentId = "document-1",
                captureId = "capture-1",
                actions = new[]
                {
                    new
                    {
                        actionId = "a1",
                        candidateId = "button-save",
                        action = "click",
                    },
                },
            }
        );
        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("invalid_xpath_evidence", error.GetProperty("code").GetString());
        Assert.Equal(0, handler.SelectionRequestCount);
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    [Fact]
    public async Task CoreSelectionRejectsAnOmittedFrameOwnerShadowDependency()
    {
        static XPathNodeEvidence Node(string id, string? candidateId, string[] hosts) =>
            new(
                id,
                candidateId,
                "button",
                "http://www.w3.org/1999/xhtml",
                [],
                "",
                [],
                0,
                false,
                null,
                1,
                1,
                null,
                [],
                [],
                hosts
            );
        var evidence = new XPathEvidenceBatch(
            "evidence",
            [Node("target", "button-save", []), Node("owner", null, ["host"]), Node("host", null, [])],
            ["target", "owner", "host"],
            [new("button-save", "target", new("f1", "child", [new("f1", "", "Frame", NodeId: "owner")]), null)]
        );
        var handler = new DeterministicServicesHandler
        {
            XPathEvidenceBody = JsonSerializer.Serialize(evidence, JsonSerializerOptions.Web),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/selections",
            new ActionSelectionRequest("document-1", "capture-1", [new("a1", "button-save", "click")])
        );
        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("invalid_xpath_evidence", error.GetProperty("code").GetString());
        Assert.Equal(0, handler.SelectionRequestCount);
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    [Fact]
    public async Task CoreSelectionGeneratesItsOwnProposalsWithoutModelInference()
    {
        var handler = new DeterministicServicesHandler();
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/selections",
            new
            {
                documentId = "document-1",
                captureId = "capture-1",
                actions = new[]
                {
                    new
                    {
                        actionId = "a1",
                        candidateId = "button-save",
                        action = "click",
                    },
                },
                xpathProposals = new[]
                {
                    new
                    {
                        nodeId = "client-invented",
                        proposals = new[]
                        {
                            new { expression = "//client-invented", requirements = Array.Empty<object>() },
                        },
                    },
                },
                xpathEvidenceId = "client-invented",
            }
        );
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(0, handler.ProviderRequestCount);
        Assert.Equal(1, handler.XPathEvidenceRequestCount);
        Assert.Equal(1, handler.SelectionRequestCount);
        Assert.Equal("browser-evidence", handler.SelectionRequest.GetProperty("xpathEvidenceId").GetString());
        Assert.Equal(
            "//*[@data-testid='save-profile']",
            handler
                .SelectionRequest.GetProperty("xpathProposals")[0]
                .GetProperty("proposals")[0]
                .GetProperty("expression")
                .GetString()
        );
        Assert.DoesNotContain("client-invented", handler.SelectionRequest.GetRawText(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("none")]
    [InlineData("frame-omitted")]
    [InlineData("frame-ancestor-omitted")]
    [InlineData("frame-order")]
    [InlineData("shadow-omitted")]
    [InlineData("shadow-order")]
    [InlineData("owner-shadow-omitted")]
    public async Task CoreSelectionBindsTheCompleteCapturedFrameAndShadowContext(string mutation)
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        var frame = JsonNode.Parse(
            """{"id":"f2","documentId":"child-document","chain":[{"frameId":"f1","nodeId":"outer","xpath":"","label":"Outer","shadowChain":[{"nodeId":"owner-host","xpath":"","label":"Owner host"}]},{"frameId":"f2","nodeId":"inner","xpath":"","label":"Inner"}]}"""
        )!;
        var shadow = JsonNode.Parse(
            """[{"nodeId":"host-one","xpath":"","label":"First"},{"nodeId":"host-two","xpath":"","label":"Second"}]"""
        )!;
        capture["candidates"]![0]!["frame"] = frame.DeepClone();
        capture["candidates"]![0]!["shadowChain"] = shadow.DeepClone();
        var target = DeterministicServicesHandler.VerifiedTarget();
        target["frame"] = frame;
        target["shadowChain"] = shadow;
        foreach (var step in frame["chain"]!.AsArray().Concat(shadow.AsArray()))
        {
            step!["xpath"] = $"//*[@data-testid='{step["nodeId"]!.GetValue<string>()}']";
        }
        frame["chain"]![0]!["shadowChain"]![0]!["xpath"] = "//*[@data-testid='owner-host']";
        switch (mutation)
        {
            case "frame-omitted":
                target.Remove("frame");
                break;
            case "frame-ancestor-omitted":
                frame["chain"]!.AsArray().RemoveAt(0);
                break;
            case "frame-order":
                frame["chain"] = new JsonArray(
                    frame["chain"]!.AsArray().Reverse().Select(step => step!.DeepClone()).ToArray()
                );
                break;
            case "shadow-omitted":
                target.Remove("shadowChain");
                break;
            case "shadow-order":
                target["shadowChain"] = new JsonArray(
                    shadow.AsArray().Reverse().Select(step => step!.DeepClone()).ToArray()
                );
                break;
            case "owner-shadow-omitted":
                frame["chain"]![0]!.AsObject().Remove("shadowChain");
                break;
        }
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = capture.ToJsonString(),
            SelectionBody = new JsonObject
            {
                ["actions"] = new JsonArray(new JsonObject { ["actionId"] = "a1", ["target"] = target }),
                ["inspectedActionId"] = "a1",
            }.ToJsonString(),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/selections",
            new
            {
                documentId = "document-1",
                captureId = "capture-1",
                actions = new[]
                {
                    new
                    {
                        actionId = "a1",
                        candidateId = "button-save",
                        action = "click",
                    },
                },
            }
        );
        Assert.Equal(mutation == "none" ? HttpStatusCode.OK : HttpStatusCode.BadGateway, response.StatusCode);
        if (mutation != "none")
        {
            var error = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("invalid_browser_selection", error.GetProperty("code").GetString());
        }
        Assert.Equal(0, handler.ProviderRequestCount);
    }
}
