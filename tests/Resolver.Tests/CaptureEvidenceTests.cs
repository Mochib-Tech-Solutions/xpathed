using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using static Xpathed.Resolver.Tests.DeterministicServicesHandler;
using static Xpathed.Resolver.Tests.ResolverTestApplication;

namespace Xpathed.Resolver.Tests;

public sealed class CaptureEvidenceTests
{
    [Theory]
    [InlineData(1, 1, 2, 2, true)]
    [InlineData(0, 1, 1, 1, true)]
    [InlineData(1, -1, 0, 1, false)]
    [InlineData(1, 1, 1, 2, false)]
    [InlineData(1, int.MaxValue, int.MinValue, int.MaxValue, false)]
    [InlineData(1, 1, 2, 1, false)]
    [InlineData(1, 0, 1, -1, false)]
    public async Task CurrentViewCoverageAccountsForExcludedCandidates(
        int captured,
        int excluded,
        int eligible,
        int scanned,
        bool valid
    )
    {
        var capture = JsonNode.Parse(CurrentViewCapture())!;
        if (captured == 0)
        {
            capture["candidates"] = new JsonArray();
        }
        capture["coverage"]!["capturedCount"] = captured;
        capture["coverage"]!["excludedOffscreenCount"] = excluded;
        capture["coverage"]!["eligibleCount"] = eligible;
        capture["coverage"]!["scannedCount"] = scanned;
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = capture.ToJsonString(),
            ProviderBody =
                captured == 0
                    ? ProviderSelection(
                        """{"complete":true,"actions":[{"step":1,"instruction":"Click Help","action":"click","outcome":"not_found","candidateId":null,"limitation":"none"}]}"""
                    )
                    : BilledSelection(),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Help",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(
            valid
                ? captured == 0
                    ? "not_found"
                    : "found"
                : "error",
            result.GetProperty("outcome").GetString()
        );
        Assert.Equal(valid ? 1 : 0, handler.ProviderRequestCount);
        if (!valid)
        {
            Assert.Equal("invalid_browser_capture", result.GetProperty("diagnostics").GetProperty("code").GetString());
        }
    }

    [Theory]
    [InlineData("page")]
    [InlineData("offscreen")]
    [InlineData("appearance")]
    public async Task InvalidCurrentViewEvidenceNeverReachesTheModel(string problem)
    {
        var capture = JsonNode.Parse(CurrentViewCapture())!;
        if (problem == "page")
        {
            capture["scope"] = "page";
        }
        if (problem == "offscreen")
        {
            capture["candidates"]![0]!["state"]!["inViewport"] = false;
        }
        if (problem == "appearance")
        {
            capture["candidates"]![0]!["appearance"]!["backgroundColor"] = "url(https://private.invalid?token=secret)";
        }
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
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
        Assert.Equal("invalid_browser_capture", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    [Fact]
    public async Task ResolvesAnInstructionToTheVerifiedTargetOnTheManagedPage()
    {
        await using var application = CreateApplication(new DeterministicServicesHandler());
        using var client = application.CreateClient();

        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save under Profile",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.Equal("page-1", result.GetProperty("pageId").GetString());
        Assert.Equal("document-1", result.GetProperty("documentId").GetString());
        Assert.Equal(
            "button-save",
            result.GetProperty("actions")[0].GetProperty("target").GetProperty("candidateId").GetString()
        );
        Assert.Equal(
            "//*[@data-testid='save-profile']",
            result.GetProperty("actions")[0].GetProperty("target").GetProperty("xpaths")[0].GetString()
        );
    }

    [Fact]
    public async Task IncompleteCaptureFailsBeforeModelInputAndInference()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["coverage"]!["complete"] = false;
        capture["coverage"]!["eligibleCount"] = 3;
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
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
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        var diagnostics = result.GetProperty("diagnostics");
        Assert.Equal("capture_incomplete", diagnostics.GetProperty("code").GetString());
        Assert.False(diagnostics.GetProperty("capture").GetProperty("complete").GetBoolean());
        Assert.Equal(3, diagnostics.GetProperty("capture").GetProperty("eligibleCount").GetInt32());
        Assert.Equal(0, diagnostics.GetProperty("modelInputCount").GetInt32());
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    [Fact]
    public async Task AResponseForAnotherDocumentFailsBeforeInference()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["documentId"] = "another-document";
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
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
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal("stale_document", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData("missing_coverage")]
    [InlineData("missing_candidates")]
    [InlineData("duplicate_candidate")]
    [InlineData("contradictory_counts")]
    public async Task InvalidBrowserCaptureFailsBeforeInference(string problem)
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        switch (problem)
        {
            case "missing_coverage":
                capture["coverage"] = null;
                break;
            case "missing_candidates":
                capture["candidates"] = null;
                break;
            case "duplicate_candidate":
                capture["candidates"]!.AsArray().Add(capture["candidates"]![0]!.DeepClone());
                capture["coverage"]!["capturedCount"] = 2;
                capture["coverage"]!["eligibleCount"] = 2;
                break;
            case "contradictory_counts":
                capture["coverage"]!["eligibleCount"] = 2;
                break;
        }
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
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
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal("invalid_browser_capture", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(0, handler.ProviderRequestCount);
    }
}
