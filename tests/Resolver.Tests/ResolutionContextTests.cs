using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using static Xpathed.Resolver.Tests.DeterministicServicesHandler;
using static Xpathed.Resolver.Tests.ResolverTestApplication;

namespace Xpathed.Resolver.Tests;

public sealed class ResolutionContextTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ShadowContextMustMatchTheCapturedCandidate(bool mismatch)
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        var chain = JsonNode.Parse("""[{"nodeId":"main:host-1","xpath":"","label":"Preferences"}]""")!;
        capture["candidates"]![0]!["shadowChain"] = chain.DeepClone();
        var target = DeterministicServicesHandler.VerifiedTarget();
        target["shadowChain"] = chain.DeepClone();
        target["shadowChain"]![0]!["xpath"] = "//*[@data-testid='main:host-1']";
        if (mismatch)
        {
            target["shadowChain"]![0]!["xpath"] = "//another-panel";
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
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(mismatch ? "error" : "found", result.GetProperty("outcome").GetString());
        if (mismatch)
        {
            Assert.Equal(
                "invalid_browser_selection",
                result.GetProperty("diagnostics").GetProperty("code").GetString()
            );
        }
        else
        {
            Assert.Equal(
                "//*[@data-testid='main:host-1']",
                result
                    .GetProperty("actions")[0]
                    .GetProperty("target")
                    .GetProperty("shadowChain")[0]
                    .GetProperty("xpath")
                    .GetString()
            );
        }

        var modelInput = handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!;
        Assert.DoesNotContain("main:host-1", modelInput, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FrameIdentityMustMatchTheCapturedCandidate(bool mismatch)
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        var frame = JsonNode.Parse(
            """{"id":"f2","documentId":"frame-document","chain":[{"frameId":"f1","nodeId":"main:outer","xpath":"","label":"Employee"},{"frameId":"f2","nodeId":"f1:inner","xpath":"","label":"Payroll"}]}"""
        )!;
        capture["candidates"]![0]!["frame"] = frame.DeepClone();
        var target = DeterministicServicesHandler.VerifiedTarget();
        target["frame"] = frame.DeepClone();
        target["frame"]!["chain"]![0]!["xpath"] = "//*[@data-testid='main:outer']";
        target["frame"]!["chain"]![1]!["xpath"] = "//*[@data-testid='f1:inner']";
        if (mismatch)
        {
            target["frame"]!["documentId"] = "another-document";
        }
        var selection = new JsonObject
        {
            ["actions"] = new JsonArray(new JsonObject { ["actionId"] = "a1", ["target"] = target }),
            ["inspectedActionId"] = "a1",
        };
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = capture.ToJsonString(),
            SelectionBody = selection.ToJsonString(),
            ProviderBody = ProviderSelection(
                """{"complete":true,"actions":[{"step":1,"instruction":"Click Save in Payroll","outcome":"found","action":"click","candidateId":"button-save","limitation":"none"}]}"""
            ),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save in Payroll",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(mismatch ? "error" : "found", result.GetProperty("outcome").GetString());
        if (mismatch)
        {
            Assert.Equal(
                "invalid_browser_selection",
                result.GetProperty("diagnostics").GetProperty("code").GetString()
            );
        }
        else
        {
            var action = result.GetProperty("actions")[0];
            Assert.Equal("f2", action.GetProperty("frameId").GetString());
            Assert.Equal(
                "frame-document",
                action.GetProperty("target").GetProperty("frame").GetProperty("documentId").GetString()
            );
            var modelInput = handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!;
            Assert.Contains("Payroll", modelInput, StringComparison.Ordinal);
            using var prepared = JsonDocument.Parse(modelInput);
            var candidate = prepared.RootElement.GetProperty("candidates")[0];
            var sentFrame = prepared.RootElement.GetProperty("context")[candidate.GetProperty("frame").GetInt32()];
            Assert.Equal("f2", sentFrame.GetProperty("id").GetString());
            Assert.Equal(2, sentFrame.GetProperty("labels").GetArrayLength());
            Assert.Equal("Employee", sentFrame.GetProperty("labels")[0].GetString());
            Assert.Equal("Payroll", sentFrame.GetProperty("labels")[1].GetString());
            Assert.DoesNotContain("frame-document", modelInput, StringComparison.Ordinal);
            Assert.DoesNotContain("//iframe", modelInput, StringComparison.Ordinal);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DeepFrameAndShadowContextsHaveNoCaptureDepthCeiling(bool shadow)
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        var target = DeterministicServicesHandler.VerifiedTarget();
        var property = shadow ? "shadowChain" : "frame";
        var chain = new JsonArray(
            Enumerable
                .Range(1, 65)
                .Select(index =>
                    (JsonNode)(
                        shadow
                            ? new JsonObject
                            {
                                ["nodeId"] = $"host-{index}",
                                ["xpath"] = "",
                                ["label"] = $"Host {index}",
                            }
                            : new JsonObject
                            {
                                ["frameId"] = $"f{index}",
                                ["nodeId"] = $"owner-{index}",
                                ["xpath"] = "",
                                ["label"] = "Frame",
                            }
                    )
                )
                .ToArray()
        );
        JsonNode context = shadow
            ? chain
            : new JsonObject
            {
                ["id"] = "f65",
                ["documentId"] = "child",
                ["chain"] = chain,
            };
        capture["candidates"]![0]![property] = context.DeepClone();
        foreach (var step in chain)
        {
            step!["xpath"] = $"//*[@data-testid='{step["nodeId"]!.GetValue<string>()}']";
        }

        target[property] = context;
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
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.Equal(1, handler.ProviderRequestCount);
        var returned = result.GetProperty("actions")[0].GetProperty("target").GetProperty(property);
        Assert.Equal(65, (shadow ? returned : returned.GetProperty("chain")).GetArrayLength());
    }
}
