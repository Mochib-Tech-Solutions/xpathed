using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Xpathed.Resolver.Tests;

public sealed class ImageRoutingContractTests
{
    private static readonly string[] SerialStages = ["capture", "routing", "preparation", "model", "validation"];

    [Fact]
    public async Task CachedRoutingStillCapturesFreshEvidenceAndImagesForEverySelection()
    {
        var handler = new DeterministicServicesHandler
        {
            RouterBody = DeterministicServicesHandler.RouterResponse(1, 0),
        };
        await using var application = ResolutionContractTests.CreateApplication(handler);
        using var client = application.CreateClient();
        for (var index = 0; index < 2; index++)
        {
            using var response = await client.PostAsJsonAsync(
                "/pages/page-1/resolve",
                new { instruction = "Click the triangle", documentId = "document-1" }
            );
            var result = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("found", result.GetProperty("outcome").GetString());
            var diagnostics = result.GetProperty("diagnostics");
            Assert.Equal(index == 1, diagnostics.GetProperty("imageRouting").GetProperty("cached").GetBoolean());
            Assert.Equal(index == 1 ? 1 : 2, diagnostics.GetProperty("modelCalls").GetInt32());
            Assert.Equal("included", diagnostics.GetProperty("imageRouting").GetProperty("status").GetString());
        }
        Assert.Equal(1, handler.RouterRequestCount);
        Assert.Equal(2, handler.CaptureRequestCount);
        Assert.Equal(2, handler.ImageRequestCount);
        Assert.Equal(2, handler.ProviderRequestCount);
    }

    [Fact]
    public async Task CancelledRoutingKeepsItsLeaseUntilCompletionAndLogsItsChargeOnce()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var logs = new AccountingLogProvider();
        var handler = new DeterministicServicesHandler
        {
            BeforeRespondAsync = async (path, token) =>
            {
                if (path == "/api/alpha/decisions")
                {
                    started.TrySetResult();
                    await release.Task.WaitAsync(token);
                }
            },
        };
        await using var application = ResolutionContractTests.CreateApplication(
            handler,
            new Dictionary<string, string?> { ["ModelUsage:ConcurrentCalls"] = "1" },
            logs
        );
        using var client = application.CreateClient();
        using var cancellation = new CancellationTokenSource();
        var request = client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" },
            cancellation.Token
        );
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => request);
        using var rejected = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        var result = await rejected.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("model_usage_limited", result.GetProperty("diagnostics").GetProperty("code").GetString());
        release.TrySetResult();
        await logs.Recorded.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var entry = Assert.Single(logs.Entries).ToDictionary(pair => pair.Key, pair => pair.Value);
        Assert.Equal(0.00000336m, entry["ReportedUsd"]);
        Assert.Equal("routing-1", entry["GenerationId"]);
        Assert.Equal(1, handler.RouterRequestCount);
        Assert.Equal(0, handler.ProviderRequestCount);
        Assert.Equal(0, handler.ImageRequestCount);
    }

    [Fact]
    public async Task AutoUsesJevAndPreservesEveryCandidateWithoutSendingAnUnneededImage()
    {
        var handler = new DeterministicServicesHandler();
        var result = await Resolve(handler);
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.Equal(1, handler.RouterRequestCount);
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal(0, handler.ImageRequestCount);
        Assert.False(handler.CaptureRequest.GetProperty("includeImage").GetBoolean());
        var diagnostics = result.GetProperty("diagnostics");
        Assert.Equal(2, diagnostics.GetProperty("modelCalls").GetInt32());
        Assert.Equal("semantic_evidence", diagnostics.GetProperty("imageRouting").GetProperty("reason").GetString());
        Assert.Equal("text_only", diagnostics.GetProperty("imageRouting").GetProperty("status").GetString());
        var calls = diagnostics.GetProperty("providerCalls");
        Assert.Equal("image_routing", calls[0].GetProperty("purpose").GetString());
        Assert.Equal("selection", calls[1].GetProperty("purpose").GetString());
        Assert.Equal(0.00000336m, calls[0].GetProperty("usage").GetProperty("cost").GetDecimal());
        Assert.Equal(0.0000215m, calls[1].GetProperty("usage").GetProperty("cost").GetDecimal());
        var content = handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!;
        using var input = JsonDocument.Parse(content);
        Assert.Equal("button-save", input.RootElement.GetProperty("candidates")[0].GetProperty("id").GetString());
        Assert.Equal("Click Save", input.RootElement.GetProperty("instruction").GetString());
        var timings = diagnostics.GetProperty("timingsMs");
        var serial = SerialStages.Sum(stage => timings.GetProperty(stage).GetDouble());
        Assert.InRange(serial, 0, timings.GetProperty("total").GetDouble());
    }

    [Fact]
    public async Task TextOnlyBypassesBothRoutingAndPixels()
    {
        var handler = new DeterministicServicesHandler
        {
            RouterBody = DeterministicServicesHandler.RouterResponse(1, 1),
        };
        var result = await Resolve(handler, "text_only");
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.Equal(0, handler.RouterRequestCount);
        Assert.Equal(0, handler.ImageRequestCount);
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal(
            "text_only_requested",
            result.GetProperty("diagnostics").GetProperty("imageRouting").GetProperty("reason").GetString()
        );
    }

    [Fact]
    public async Task AutoImageUsesTheSameCaptureAndRetainsNoPixelsInResponse()
    {
        var handler = new DeterministicServicesHandler
        {
            RouterBody = DeterministicServicesHandler.RouterResponse(0.99, 0.01),
        };
        await using var application = ResolutionContractTests.CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click the triangle", documentId = "document-1" }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.Equal(
            "included",
            result.GetProperty("diagnostics").GetProperty("imageRouting").GetProperty("status").GetString()
        );
        Assert.Equal("capture-1", handler.ImageRequest.GetProperty("captureId").GetString());
        Assert.Equal("document-1", handler.ImageRequest.GetProperty("documentId").GetString());
        Assert.False(handler.CaptureRequest.GetProperty("includeImage").GetBoolean());
        var content = handler.ModelRequest.GetProperty("messages")[1].GetProperty("content");
        Assert.Equal(2, content.GetArrayLength());
        Assert.Equal("text", content[0].GetProperty("type").GetString());
        Assert.Equal("image_url", content[1].GetProperty("type").GetString());
        Assert.StartsWith("data:image/png;base64,", content[1].GetProperty("image_url").GetProperty("url").GetString());
        Assert.DoesNotContain("data:image", result.GetRawText(), StringComparison.Ordinal);
        Assert.DoesNotContain("iVBOR", result.GetRawText(), StringComparison.Ordinal);
        Assert.Equal(1, handler.RouterRequestCount);
        Assert.Equal(1, handler.ImageRequestCount);
        Assert.Equal(1, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("malformed")]
    [InlineData("dimensions")]
    [InlineData("identity")]
    public async Task InvalidLazyImageNeverReachesTheSelectionModel(string problem)
    {
        var image = JsonNode.Parse(new DeterministicServicesHandler().ImageBody)!;
        if (problem == "missing")
        {
            image["image"] = null;
        }
        if (problem == "malformed")
        {
            image["image"]!["png"] = Convert.ToBase64String(new byte[24]);
        }
        if (problem == "dimensions")
        {
            image["image"]!["width"] = 2;
        }
        if (problem == "identity")
        {
            image["captureId"] = "another-capture";
        }
        var handler = new DeterministicServicesHandler
        {
            RouterBody = DeterministicServicesHandler.RouterResponse(1, 0),
            ImageBody = image.ToJsonString(),
        };
        var result = await Resolve(handler);
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal(
            problem == "identity" ? "stale_capture" : "invalid_browser_capture",
            result.GetProperty("diagnostics").GetProperty("code").GetString()
        );
        Assert.Equal(1, handler.RouterRequestCount);
        Assert.Equal(0, handler.ProviderRequestCount);
        Assert.Equal(0, handler.SelectionRequestCount);
    }

    [Fact]
    public async Task UnrequestedImageIsRejectedBeforeAnyInference()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["image"] = JsonNode.Parse(new DeterministicServicesHandler().ImageBody)!["image"]!.DeepClone();
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
        var result = await Resolve(handler);
        Assert.Equal("invalid_browser_capture", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(0, handler.RouterRequestCount);
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData("malformed", "router_unavailable")]
    [InlineData("unavailable", "router_unavailable")]
    [InlineData("uncertain", "uncertain_route")]
    public async Task RouterFailureOrUncertaintyUsesMaskedPixelsWithoutRetry(string scenario, string reason)
    {
        var handler = new DeterministicServicesHandler
        {
            RouterBody = scenario == "malformed" ? "{}" : DeterministicServicesHandler.RouterResponse(0.5, 0.01),
            RouterStatus = scenario == "unavailable" ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK,
        };
        var result = await Resolve(handler);
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.Equal(
            reason,
            result.GetProperty("diagnostics").GetProperty("imageRouting").GetProperty("reason").GetString()
        );
        Assert.Equal(1, handler.RouterRequestCount);
        Assert.Equal(1, handler.ImageRequestCount);
        Assert.Equal(1, handler.ProviderRequestCount);
    }

    [Fact]
    public async Task MaskingFailureFallsBackToTextWithAnExplicitLimitation()
    {
        var handler = new DeterministicServicesHandler
        {
            RouterBody = DeterministicServicesHandler.RouterResponse(1, 0),
            ImageStatus = HttpStatusCode.Conflict,
            ImageBody = """{"code":"capture_image_unavailable","message":"Masking is unavailable."}""",
        };
        var result = await Resolve(handler);
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.Equal(
            JsonValueKind.String,
            handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").ValueKind
        );
        var routing = result.GetProperty("diagnostics").GetProperty("imageRouting");
        Assert.Equal("unavailable", routing.GetProperty("status").GetString());
        Assert.Equal("image_unavailable", routing.GetProperty("reason").GetString());
    }

    [Fact]
    public async Task BothCallsShareTheSameAdmissionAllowance()
    {
        var handler = new DeterministicServicesHandler();
        await using var application = ResolutionContractTests.CreateApplication(
            handler,
            new Dictionary<string, string?> { ["ModelUsage:CallsPerDay"] = "1" }
        );
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("model_usage_limited", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(1, result.GetProperty("diagnostics").GetProperty("modelCalls").GetInt32());
        Assert.Equal(1, handler.RouterRequestCount);
        Assert.Equal(0, handler.ProviderRequestCount);
        Assert.Equal(
            0.00000336m,
            result
                .GetProperty("diagnostics")
                .GetProperty("providerCalls")[0]
                .GetProperty("usage")
                .GetProperty("cost")
                .GetDecimal()
        );
    }

    [Theory]
    [InlineData("always")]
    [InlineData("")]
    [InlineData("AUTO")]
    public async Task UnknownImagePolicyIsRejectedBeforeCapture(string mode)
    {
        var handler = new DeterministicServicesHandler();
        await using var application = ResolutionContractTests.CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                imageMode = mode,
            }
        );
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(JsonValueKind.Undefined, handler.CaptureRequest.ValueKind);
    }

    private static async Task<JsonElement> Resolve(DeterministicServicesHandler handler, string? mode = null)
    {
        await using var application = ResolutionContractTests.CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                imageMode = mode ?? "auto",
            }
        );
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }
}
