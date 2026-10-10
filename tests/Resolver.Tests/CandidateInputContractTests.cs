using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using static Xpathed.Resolver.Tests.DeterministicServicesHandler;
using static Xpathed.Resolver.Tests.ResolverTestApplication;

namespace Xpathed.Resolver.Tests;

public sealed class CandidateInputContractTests
{
    [Theory]
    [InlineData(null, false)]
    [InlineData("rendered", false)]
    [InlineData("enabled", false)]
    [InlineData("editable", true)]
    [InlineData("readonly", true)]
    public async Task CurrentViewCompactStatePreservesMeaningfulFlags(string? flag, bool value)
    {
        var capture = JsonNode.Parse(CurrentViewCapture())!;
        var state = capture["candidates"]![0]!["state"]!;
        if (flag is not null)
        {
            state[flag] = value;
        }
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = capture.ToJsonString(),
            ProviderBody = BilledSelection(),
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
        using var input = JsonDocument.Parse(
            handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!
        );
        var candidate = input.RootElement.GetProperty("candidates")[0];
        Assert.Equal(flag is not null, candidate.TryGetProperty("state", out var actual));
        if (flag is not null)
        {
            Assert.False(actual.TryGetProperty("inViewport", out _));
            Assert.Single(actual.EnumerateObject());
            Assert.Equal(value, actual.GetProperty(flag).GetBoolean());
        }
        Assert.False(
            input
                .RootElement.GetProperty("context")[candidate.GetProperty("appearance").GetInt32()]
                .TryGetProperty("limitations", out _)
        );
        Assert.Equal(
            "rgb(255, 0, 0)",
            input
                .RootElement.GetProperty("context")[candidate.GetProperty("appearance").GetInt32()]
                .GetProperty("backgroundColor")
                .GetString()
        );
        Assert.Equal(20, candidate.GetProperty("geometry")[0].GetInt32());
    }

    [Theory]
    [InlineData("current_view")]
    public async Task CurrentViewCarriesAppearance(string scope)
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["scope"] = scope;
        capture["candidates"]![0]!["appearance"] = JsonNode.Parse(
            """{"backgroundColor":"rgb(255, 0, 0)","textColor":"rgb(255, 255, 255)","borderColor":null,"limitations":["background_transparent"]}"""
        );
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = capture.ToJsonString(),
            ProviderBody = BilledSelection(),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        const string instruction = "Click the red Save control at the left of Profile";
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction,
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.Equal(scope, handler.CaptureRequest.GetProperty("scope").GetString());
        using var input = JsonDocument.Parse(
            handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!
        );
        Assert.Equal(instruction, input.RootElement.GetProperty("instruction").GetString());
        var candidate = input.RootElement.GetProperty("candidates")[0];
        Assert.Equal("button-save", candidate.GetProperty("id").GetString());
        Assert.Equal(
            "Profile",
            input.RootElement.GetProperty("context")[candidate.GetProperty("scope").GetInt32()][0].GetString()
        );
        Assert.Equal(20, candidate.GetProperty("geometry")[0].GetInt32());
        Assert.Equal("current_view", input.RootElement.GetProperty("scope").GetString());
        Assert.Equal(
            "rgb(255, 0, 0)",
            input
                .RootElement.GetProperty("context")[candidate.GetProperty("appearance").GetInt32()]
                .GetProperty("backgroundColor")
                .GetString()
        );
        Assert.Equal(
            "background_transparent",
            input
                .RootElement.GetProperty("context")[candidate.GetProperty("appearance").GetInt32()]
                .GetProperty("limitations")[0]
                .GetString()
        );
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal(1, handler.SelectionRequestCount);
    }

    [Fact]
    public async Task ModelInputRetainsItemParentsAndNearestVisualNeighborsWithoutDroppingControls()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        var button = capture["candidates"]![0]!.DeepClone();
        button["parentId"] = "card";
        JsonNode Card(string id, double x, double y)
        {
            var card = button.DeepClone();
            card.AsObject().Remove("parentId");
            card["id"] = id;
            card["tag"] = "div";
            card["role"] = "";
            card["label"] = "";
            card["text"] = "Item Save";
            card["isRepeatedItem"] = true;
            card["geometry"] = JsonSerializer.SerializeToNode(
                new
                {
                    x,
                    y,
                    width = 200,
                    height = 200,
                }
            );
            return card;
        }
        capture["candidates"] = new JsonArray(
            Card("card", 0, 0),
            button,
            Card("right", 220, 0),
            Card("below", 0, 220),
            Card("tied-below", 120, 220)
        );
        capture["coverage"]!["scannedCount"] = 10;
        capture["coverage"]!["eligibleCount"] = 5;
        capture["coverage"]!["capturedCount"] = 5;
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
        using var input = JsonDocument.Parse(
            handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!
        );
        var candidates = input.RootElement.GetProperty("candidates");
        Assert.Equal(5, candidates.GetArrayLength());
        Assert.Equal("card", candidates[1].GetProperty("parentId").GetString());
        Assert.Equal("button-save", candidates[1].GetProperty("id").GetString());
        Assert.False(candidates[0].TryGetProperty("neighbors", out _));
        Assert.False(candidates[1].TryGetProperty("neighbors", out _));
        Assert.False(candidates[1].TryGetProperty("appearance", out _));
        Assert.Equal(1, handler.ProviderRequestCount);
        var layout = input.RootElement.GetProperty("layout");
        Assert.Equal(4, layout.GetArrayLength());
        Assert.Equal("Save", layout[0].GetProperty("description").GetString());
        Assert.Equal("right", layout[0].GetProperty("neighbors").GetProperty("right")[0].GetProperty("id").GetString());
        var below = layout[0].GetProperty("neighbors").GetProperty("below");
        Assert.Equal(2, below.GetArrayLength());
        Assert.Equal("below", below[0].GetProperty("id").GetString());
        Assert.Equal("tied-below", below[1].GetProperty("id").GetString());
    }

    [Fact]
    public async Task ModelInputRetainsOrdinaryCaptureShapeWithoutRepeatedItems()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        var button = capture["candidates"]![0]!.DeepClone();
        var heading = button.DeepClone();
        heading["id"] = "heading";
        heading["tag"] = "h2";
        heading["role"] = "";
        heading["label"] = "";
        heading["text"] = "Profile";
        button["parentId"] = "heading";
        capture["candidates"] = new JsonArray(heading, button);
        capture["coverage"]!["scannedCount"] = 2;
        capture["coverage"]!["eligibleCount"] = 2;
        capture["coverage"]!["capturedCount"] = 2;
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
        using var input = JsonDocument.Parse(
            handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!
        );
        Assert.False(input.RootElement.TryGetProperty("layout", out _));
        var candidates = input.RootElement.GetProperty("candidates");
        Assert.Equal(2, candidates.GetArrayLength());
        Assert.Equal("button-save", candidates[1].GetProperty("id").GetString());
        Assert.False(candidates[1].TryGetProperty("parentId", out _));
        Assert.False(candidates[1].TryGetProperty("neighbors", out _));
        Assert.Equal(1, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData("button-save")]
    [InlineData("missing-parent")]
    public async Task InvalidCandidateParentsFailBeforeProviderInference(string parentId)
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["candidates"]![0]!["parentId"] = parentId;
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
    public async Task CompactModelInputPreservesCandidatesAndMeaningWithoutDuplicateOrPrivateState()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["candidates"]![0]!["appearance"] = JsonNode.Parse(
            """{"backgroundColor":"rgb(255, 0, 0)","textColor":null,"borderColor":null,"limitations":[]}"""
        );
        var candidates = capture["candidates"]!.AsArray();
        var second = candidates[0]!.DeepClone();
        second["id"] = "other-save";
        second["frame"] = JsonNode.Parse("""{"id":"main","documentId":"document-1","chain":[]}""");
        second["text"] = "Save changes";
        second["state"]!["enabled"] = false;
        second["state"]!["readonly"] = true;
        candidates.Add(second);
        capture["coverage"]!["eligibleCount"] = 2;
        capture["coverage"]!["capturedCount"] = 2;
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save in Profile",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        using var input = JsonDocument.Parse(
            handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!
        );
        var sent = input.RootElement.GetProperty("candidates");
        Assert.Equal(2, sent.GetArrayLength());
        Assert.Equal("button-save", sent[0].GetProperty("id").GetString());
        Assert.Equal("Save", sent[0].GetProperty("label").GetString());
        Assert.Equal(
            "Profile",
            input.RootElement.GetProperty("context")[sent[0].GetProperty("scope").GetInt32()][0].GetString()
        );
        Assert.Equal(20, sent[0].GetProperty("geometry")[0].GetDouble());
        Assert.False(sent[0].TryGetProperty("text", out _));
        Assert.False(sent[0].TryGetProperty("placeholder", out _));
        Assert.False(sent[0].TryGetProperty("state", out _));
        Assert.False(sent[0].TryGetProperty("frame", out _));
        Assert.False(sent[1].TryGetProperty("frame", out _));
        Assert.Equal("main", input.RootElement.GetProperty("frameId").GetString());
        Assert.Equal(sent[0].GetProperty("scope").GetInt32(), sent[1].GetProperty("scope").GetInt32());
        Assert.Equal(sent[0].GetProperty("appearance").GetInt32(), sent[1].GetProperty("appearance").GetInt32());
        Assert.Equal(2, input.RootElement.GetProperty("context").GetArrayLength());
        Assert.Equal(4, sent[0].GetProperty("geometry").GetArrayLength());
        Assert.Equal(40, sent[0].GetProperty("geometry")[1].GetDouble());
        Assert.Equal(90, sent[0].GetProperty("geometry")[2].GetDouble());
        Assert.Equal(30, sent[0].GetProperty("geometry")[3].GetDouble());
        Assert.Equal("Save changes", sent[1].GetProperty("text").GetString());
        Assert.False(sent[1].GetProperty("state").GetProperty("enabled").GetBoolean());
        Assert.True(sent[1].GetProperty("state").GetProperty("readonly").GetBoolean());
    }

    [Fact]
    public async Task RepresentationAboveTheOldBudgetReachesInferenceWithoutTruncation()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["candidates"]![0]!["text"] = new string('x', 100000);
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
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.True(result.GetProperty("diagnostics").GetProperty("modelInputBytes").GetInt32() > 100000);
        Assert.Equal(1, handler.ProviderRequestCount);
    }

    [Fact]
    public async Task LargeCurrentViewRepresentationReachesInferenceWithoutTruncation()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["candidates"]![0]!["text"] = new string('x', 512000);
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
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        var diagnostics = result.GetProperty("diagnostics");
        Assert.True(diagnostics.GetProperty("capture").GetProperty("complete").GetBoolean());
        Assert.True(diagnostics.GetProperty("modelInputBytes").GetInt32() > 512000);
        Assert.Equal(JsonValueKind.Null, diagnostics.GetProperty("modelInputBudgetBytes").ValueKind);
        Assert.Equal(1, diagnostics.GetProperty("modelCalls").GetInt32());
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Contains(
            new string('x', 512000),
            handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!,
            StringComparison.Ordinal
        );
    }

    [Fact]
    public async Task DifferentInstructionsPreserveTheExactPageEvidencePrefix()
    {
        var handler = new DeterministicServicesHandler { CaptureBody = CurrentViewCapture() };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        string? prefix = null;
        foreach (var instruction in new[] { "Click Save", "Click the Save button" })
        {
            using var response = await client.PostAsJsonAsync(
                "/pages/page-1/resolve",
                new
                {
                    instruction,
                    documentId = "document-1",
                    imageMode = "text_only",
                }
            );
            var result = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("found", result.GetProperty("outcome").GetString());
            var input = handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!;
            using var parsed = JsonDocument.Parse(input);
            Assert.Equal(instruction, parsed.RootElement.GetProperty("instruction").GetString());
            Assert.Equal("instruction", parsed.RootElement.EnumerateObject().Last().Name);
            Assert.Equal(1, parsed.RootElement.GetProperty("candidates").GetArrayLength());
            var instructionStart = input.LastIndexOf(",\"instruction\":", StringComparison.Ordinal);
            Assert.True(instructionStart > 0);
            prefix ??= input[..instructionStart];
            Assert.Equal(prefix, input[..instructionStart]);
            var timings = result.GetProperty("diagnostics").GetProperty("timingsMs");
            var model = timings.GetProperty("model").GetDouble();
            Assert.InRange(timings.GetProperty("provider").GetDouble(), 0, model);
            var measured =
                timings.GetProperty("capture").GetDouble()
                + timings.GetProperty("preparation").GetDouble()
                + model
                + timings.GetProperty("validation").GetDouble();
            Assert.InRange(measured, 0, timings.GetProperty("total").GetDouble());
        }
    }

    [Fact]
    public async Task ModelInputExcludesBrowserCapabilityIdentitiesAndCaptureBookkeeping()
    {
        var handler = new DeterministicServicesHandler();
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
        var input = handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!;
        Assert.DoesNotContain("session-1", input, StringComparison.Ordinal);
        Assert.DoesNotContain("page-1", input, StringComparison.Ordinal);
        Assert.DoesNotContain("document-1", input, StringComparison.Ordinal);
        Assert.DoesNotContain("capture-1", input, StringComparison.Ordinal);
        Assert.DoesNotContain("capturedAt", input, StringComparison.Ordinal);
        Assert.DoesNotContain("coverage", input, StringComparison.Ordinal);
        Assert.Contains("button-save", input, StringComparison.Ordinal);
        Assert.Contains("Profile", input, StringComparison.Ordinal);
    }
}
