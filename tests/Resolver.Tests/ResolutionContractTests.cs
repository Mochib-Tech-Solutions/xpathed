using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xpathed.Resolver.Controllers;

namespace Xpathed.Resolver.Tests;

public sealed class ResolutionContractTests
{
    [Theory]
    [InlineData("click", "blocked", "found")]
    [InlineData("hover", "blocked", "error")]
    [InlineData("click", "ready", "error")]
    public async Task VersionedReadinessMustBelongToTheSelectedAction(string assessedAction, string status, string outcome)
    {
        var handler = new DeterministicServicesHandler
        {
            SelectionBody = """
                {"target":{"candidateId":"button-save","tag":"button","label":"Save","xpaths":["//button"],
                  "state":{"version":"2","accessibilityExposed":true,"rendered":true,"inViewport":true,"enabled":false,"editable":false,"readonly":false,"checked":null},
                  "geometry":{"x":20,"y":40,"width":90,"height":30},
                  "interactability":{"version":"1","action":"ACTION","status":"STATUS","reasons":["disabled"],
                    "checks":{"compatibleControl":"pass","enabled":"fail","writable":"not_applicable","viewport":"pass",
                      "pointerReception":"pass","keyboard":"not_applicable","stability":"unknown","eventOutcome":"unknown"}}}}
                """.Replace("ACTION", assessedAction, StringComparison.Ordinal).Replace("STATUS", status, StringComparison.Ordinal)
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" });
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(outcome, result.GetProperty("outcome").GetString());
        if (outcome == "found")
        {
            Assert.Equal("1", result.GetProperty("contractVersion").GetString());
            Assert.Equal("blocked", result.GetProperty("target").GetProperty("interactability").GetProperty("status").GetString());
            Assert.Equal(1, result.GetProperty("diagnostics").GetProperty("modelCalls").GetInt32());
        }
        else
        {
            Assert.Equal("invalid_browser_selection", result.GetProperty("diagnostics").GetProperty("code").GetString());
        }
    }

    [Fact]
    public async Task ResolvesAnInstructionToTheVerifiedTargetOnTheManagedPage()
    {
        await using var application = CreateApplication(new DeterministicServicesHandler());
        using var client = application.CreateClient();

        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new
        {
            instruction = "Click Save under Profile",
            documentId = "document-1"
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.Equal("page-1", result.GetProperty("pageId").GetString());
        Assert.Equal("document-1", result.GetProperty("documentId").GetString());
        Assert.Equal("button-save", result.GetProperty("target").GetProperty("candidateId").GetString());
        Assert.Equal("//*[@data-testid='save-profile']", result.GetProperty("target").GetProperty("xpaths")[0].GetString());
    }

    [Fact]
    public async Task AProviderSelectionOutsideTheCaptureIsAnErrorWithProviderEvidence()
    {
        await using var application = CreateApplication(new DeterministicServicesHandler
        {
            ProviderBody = """
                {"id":"generation-unknown","model":"deepseek/deepseek-v4.1-flash","provider":"Wafer",
                 "choices":[{"finish_reason":"stop","message":{"content":"{\"outcome\":\"found\",\"action\":\"click\",\"candidateId\":\"invented\"}"}}],
                 "usage":{"prompt_tokens":140,"completion_tokens":15,"total_tokens":155,"cost":0.0000215,"completion_tokens_details":{"reasoning_tokens":0}}}
                """
        });
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("target").ValueKind);
        var diagnostics = result.GetProperty("diagnostics");
        Assert.Equal("provider_unknown_candidate", diagnostics.GetProperty("code").GetString());
        Assert.Equal("generation-unknown", diagnostics.GetProperty("generationId").GetString());
        Assert.Equal("Wafer", diagnostics.GetProperty("provider").GetString());
        Assert.Equal(140, diagnostics.GetProperty("usage").GetProperty("inputTokens").GetInt64());
        Assert.Equal(0, diagnostics.GetProperty("usage").GetProperty("reasoningTokens").GetInt64());
        Assert.Equal(JsonValueKind.Null, diagnostics.GetProperty("usage").GetProperty("cachedTokens").ValueKind);
    }

    [Theory]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("{")]
    [InlineData("{}")]
    [InlineData("""{"outcome":"found","action":"click"}""")]
    [InlineData("""{"outcome":"found","action":"click","candidateId":null}""")]
    [InlineData("""{"outcome":"not_found","action":"click","candidateId":"button-save"}""")]
    [InlineData("""{"outcome":"other","action":"click","candidateId":null}""")]
    [InlineData("""{"outcome":"found","action":null,"candidateId":"button-save"}""")]
    [InlineData("""{"outcome":"found","action":"execute","candidateId":"button-save"}""")]
    [InlineData("""{"outcome":"unsupported","action":"click","candidateId":null}""")]
    [InlineData("""{"outcome":"found","action":"click","candidateId":"button-save","extra":true}""")]
    [InlineData("""{"outcome":"found","action":"click","candidateId":"button-save","candidateId":"button-save"}""")]
    public async Task InvalidSelectionShapesCannotBecomeSemanticResults(string selection)
    {
        await using var application = CreateApplication(new DeterministicServicesHandler { ProviderBody = ProviderSelection(selection) });
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal("provider_malformed_response", result.GetProperty("diagnostics").GetProperty("code").GetString());
    }

    [Theory]
    [InlineData(401, "{}", "provider_authentication")]
    [InlineData(429, "{}", "provider_rate_limited")]
    [InlineData(408, "{}", "provider_timeout")]
    [InlineData(503, "{}", "provider_unavailable")]
    [InlineData(200, """{"error":{"code":401,"metadata":{"error_type":"authentication"}}}""", "provider_authentication")]
    [InlineData(200, """{"choices":[{"finish_reason":"error","error":{"code":429,"metadata":{"error_type":"rate_limit_exceeded"}}}]}""", "provider_rate_limited")]
    [InlineData(200, "{", "provider_malformed_response")]
    [InlineData(200, "{}", "provider_malformed_response")]
    [InlineData(200, """{"choices":[]}""", "provider_malformed_response")]
    [InlineData(200, """{"choices":[{"finish_reason":"stop","message":{"content":""}}]}""", "provider_empty_response")]
    [InlineData(200, """{"choices":[{"finish_reason":"length","message":{"content":""}}]}""", "provider_truncated_response")]
    [InlineData(200, """{"choices":[{"finish_reason":"content_filter","message":{"content":null,"refusal":"Declined"}}]}""", "provider_refused")]
    public async Task ProviderFailuresRemainDistinctFromSemanticAbsence(int status, string body, string code)
    {
        await using var application = CreateApplication(new DeterministicServicesHandler { ProviderStatus = (HttpStatusCode)status, ProviderBody = body });
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal(code, result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("target").ValueKind);
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
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" });

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
    public async Task OversizedRepresentationFailsWithoutTruncationOrInference()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["candidates"]![0]!["text"] = new string('x', 64000);
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" });

        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        var diagnostics = result.GetProperty("diagnostics");
        Assert.Equal("model_input_budget_exceeded", diagnostics.GetProperty("code").GetString());
        Assert.True(diagnostics.GetProperty("capture").GetProperty("complete").GetBoolean());
        Assert.True(diagnostics.GetProperty("modelInputBytes").GetInt32() > 64000);
        Assert.Equal(0, diagnostics.GetProperty("modelCalls").GetInt32());
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData("not_found", "click", 0, "not_found")]
    [InlineData("not_found", "click", 1, "unsupported")]
    [InlineData("unsupported", "unsupported", 0, "unsupported")]
    public async Task SemanticAbsenceAndUnsupportedResultsValidateTheCurrentCapture(string outcome, string action, int boundaries, string expected)
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["unsupportedBoundaryCount"] = boundaries;
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = capture.ToJsonString(),
            ProviderBody = ProviderSelection(JsonSerializer.Serialize(new { outcome, action, candidateId = (string?)null }))
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Missing", documentId = "document-1" });

        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(expected, result.GetProperty("outcome").GetString());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("target").ValueKind);
        Assert.Equal(JsonValueKind.Null, result.GetProperty("diagnostics").GetProperty("provider").ValueKind);
        Assert.Equal(JsonValueKind.Null, result.GetProperty("diagnostics").GetProperty("usage").ValueKind);
        Assert.Equal(JsonValueKind.Null, result.GetProperty("diagnostics").GetProperty("costEstimate").ValueKind);
        Assert.Equal(1, handler.SelectionRequestCount);
        Assert.Equal(1, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData("found", "click", "button-save", "stale_document")]
    [InlineData("not_found", "click", null, "stale_document")]
    [InlineData("unsupported", "unsupported", null, "stale_document")]
    [InlineData("found", "click", "button-save", "validation_budget_exceeded")]
    [InlineData("found", "click", "button-save", "inactive_page")]
    public async Task BrowserValidationFailuresPreserveSafeCodesForSemanticOutcomes(string outcome, string action, string? candidateId, string code)
    {
        var handler = new DeterministicServicesHandler
        {
            ProviderBody = ProviderSelection(JsonSerializer.Serialize(new { outcome, action, candidateId })),
            SelectionStatus = HttpStatusCode.Conflict,
            SelectionBody = JsonSerializer.Serialize(new { code, message = "Browser validation failed.", traceId = "browser-trace" })
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal(code, result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal("generation-1", result.GetProperty("diagnostics").GetProperty("generationId").GetString());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("target").ValueKind);
    }

    [Fact]
    public async Task AResponseForAnotherDocumentFailsBeforeInference()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["documentId"] = "another-document";
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" });

        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal("stale_document", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData("/api/v1/chat/completions", "provider_timeout")]
    [InlineData("/pages/page-1/capture", "browser_timeout")]
    [InlineData("/pages/page-1/selection", "browser_timeout")]
    public async Task UpstreamTimeoutsRemainOperationalErrors(string failedPath, string expectedCode)
    {
        var handler = new DeterministicServicesHandler
        {
            BeforeRespondAsync = (path, _) => path == failedPath ? Task.FromException(new OperationCanceledException()) : Task.CompletedTask
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal(expectedCode, result.GetProperty("diagnostics").GetProperty("code").GetString());
    }

    [Theory]
    [InlineData("/api/v1/chat/completions")]
    [InlineData("/pages/page-1/capture")]
    [InlineData("/pages/page-1/selection")]
    [InlineData("/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints")]
    public async Task RequestCancellationReachesEveryUpstreamBoundary(string blockedPath)
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new DeterministicServicesHandler
        {
            BeforeRespondAsync = async (path, cancellationToken) =>
            {
                if (path != blockedPath)
                {
                    return;
                }
                started.SetResult();
                try
                {
                    await Task.Delay(Timeout.Infinite, cancellationToken);
                }
                finally
                {
                    cancelled.SetResult();
                }
            }
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var cancellation = new CancellationTokenSource();
        var response = client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" }, cancellation.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await cancellation.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => response);
        await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Theory]
    [InlineData("""{"target":null}""")]
    [InlineData("""{"target":{"candidateId":"different","tag":"button","label":"Save","xpaths":["//*[@id='different']"]}}""")]
    public async Task AContradictoryBrowserSelectionCannotBecomeFound(string body)
    {
        await using var application = CreateApplication(new DeterministicServicesHandler { SelectionBody = body });
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" });

        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal("invalid_browser_selection", result.GetProperty("diagnostics").GetProperty("code").GetString());
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("""{"instruction":" ","documentId":"document-1"}""")]
    [InlineData("""{"instruction":"Click Save","documentId":null}""")]
    [InlineData("{")]
    public async Task InvalidPublicRequestsReturnTheExistingBadRequestEnvelope(string body)
    {
        var handler = new DeterministicServicesHandler();
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
        using var response = await client.PostAsync("/pages/page-1/resolve", content);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("invalid_request", result.GetProperty("code").GetString());
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData("OpenRouter:ApiKey", null, "provider_not_configured")]
    [InlineData("Resolution:Strategy", "unimplemented", "unsupported_strategy")]
    [InlineData("OpenRouter:BaseUrl", "file:///tmp/model/", "invalid_provider_configuration")]
    [InlineData("OpenRouter:BaseUrl", "http://user:password@localhost/api/v1/", "invalid_provider_configuration")]
    [InlineData("OpenRouter:TimeoutSeconds", "0", "invalid_provider_configuration")]
    [InlineData("OpenRouter:TimeoutSeconds", "invalid", "invalid_provider_configuration")]
    [InlineData("OpenRouter:TimeoutSeconds", "601", "invalid_provider_configuration")]
    [InlineData("OpenRouter:TimeoutSeconds", "NaN", "invalid_provider_configuration")]
    [InlineData("OpenRouter:TimeoutSeconds", "Infinity", "invalid_provider_configuration")]
    [InlineData("OpenRouter:TimeoutSeconds", "-Infinity", "invalid_provider_configuration")]
    public async Task InvalidConfigurationCannotClaimAModelCall(string key, string? value, string expectedCode)
    {
        var handler = new DeterministicServicesHandler();
        await using var application = CreateApplication(handler, new Dictionary<string, string?> { [key] = value });
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" });
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal(expectedCode, result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(0, result.GetProperty("diagnostics").GetProperty("modelCalls").GetInt32());
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData("OpenRouter:Model", "other/model", "Click Save", false)]
    [InlineData("OpenRouter:Provider", "other", "Click Save", false)]
    [InlineData("OpenRouter:BaseUrl", "http://localhost:9089/api/v1/", "Click Save", false)]
    [InlineData("OpenRouter:TimeoutSeconds", "31", "Click Save", false)]
    [InlineData("OpenRouter:ApiKey", "another-test-key", "Click Save", true)]
    [InlineData("OpenRouter:ApiKey", "another-test-key", "Hover over Save", true)]
    public async Task ConfigurationIdentityDependsOnSettingsAndExcludesKeyAndInstruction(string key, string value, string instruction, bool sameConfiguration)
    {
        var first = await ResolveConfigurationAsync([], "Click Save");
        var changed = await ResolveConfigurationAsync(new Dictionary<string, string?> { [key] = value }, instruction);
        if (sameConfiguration)
        {
            Assert.Equal(first, changed);
        }
        else
        {
            Assert.NotEqual(first, changed);
        }

        static async Task<string?> ResolveConfigurationAsync(Dictionary<string, string?> settings, string instruction)
        {
            await using var application = CreateApplication(new DeterministicServicesHandler(), settings);
            using var client = application.CreateClient();
            using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction, documentId = "document-1" });
            var result = await response.Content.ReadFromJsonAsync<JsonElement>();
            return result.GetProperty("configurationId").GetString();
        }
    }

    [Fact]
    public async Task ProviderRequestPinsSupportedSettingsAndPreservesUnicodeLabels()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["candidates"]![0]!["label"] = "Sauvegarder 東京";
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = handler.ModelRequest;
        Assert.Equal("deepseek/deepseek-v4.1-flash", body.GetProperty("model").GetString());
        Assert.False(body.GetProperty("reasoning").GetProperty("enabled").GetBoolean());
        Assert.False(body.TryGetProperty("service_tier", out _));
        Assert.Equal(512, body.GetProperty("max_tokens").GetInt32());
        Assert.Equal("wafer", body.GetProperty("provider").GetProperty("only")[0].GetString());
        Assert.False(body.GetProperty("provider").TryGetProperty("max_price", out _));
        Assert.False(body.GetProperty("provider").GetProperty("allow_fallbacks").GetBoolean());
        Assert.True(body.GetProperty("provider").GetProperty("require_parameters").GetBoolean());
        Assert.True(body.GetProperty("response_format").GetProperty("json_schema").GetProperty("strict").GetBoolean());
        Assert.False(body.TryGetProperty("tools", out _));
        Assert.False(body.TryGetProperty("temperature", out _));
        Assert.Contains("東京", body.GetProperty("messages")[1].GetProperty("content").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReturnsRouteRatesAndTokenCostEstimateSeparatelyFromReportedCost()
    {
        var handler = new DeterministicServicesHandler
        {
            PricingBody = """
                {"data":{"endpoints":[
                  {"provider_name":"Other","pricing":{"prompt":"99","completion":"99"}},
                  {"provider_name":"Wafer","pricing":{"prompt":"0.0000000749","completion":"0.00000044","request":"0.000001"}}]}}
                """
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" });
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        var diagnostics = result.GetProperty("diagnostics");
        var estimate = diagnostics.GetProperty("costEstimate");
        Assert.Equal("USD", estimate.GetProperty("currency").GetString());
        Assert.Equal(0.0749m, estimate.GetProperty("inputPricePerMillion").GetDecimal());
        Assert.Equal(0.44m, estimate.GetProperty("outputPricePerMillion").GetDecimal());
        Assert.Equal(0.000010486m, estimate.GetProperty("inputCost").GetDecimal());
        Assert.Equal(0.0000066m, estimate.GetProperty("outputCost").GetDecimal());
        Assert.Equal(0.000001m, estimate.GetProperty("requestCost").GetDecimal());
        Assert.Equal(0.000018086m, estimate.GetProperty("totalCost").GetDecimal());
        Assert.Equal(0.0000215m, diagnostics.GetProperty("usage").GetProperty("cost").GetDecimal());
        Assert.NotEqual(default, estimate.GetProperty("pricingFetchedAt").GetDateTimeOffset());
        Assert.Equal(1, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData(503, "{}")]
    [InlineData(200, "{")]
    [InlineData(200, "null")]
    [InlineData(200, """{"data":{"endpoints":[]}}""")]
    [InlineData(200, """{"data":{"endpoints":[{"provider_name":"Other","pricing":{"prompt":"1","completion":"1"}}]}}""")]
    [InlineData(200, """{"data":{"endpoints":[{"provider_name":"Wafer","pricing":{"prompt":"-1","completion":"1"}}]}}""")]
    [InlineData(200, """{"data":{"endpoints":[{"provider_name":"Wafer","pricing":{"prompt":"1"}}]}}""")]
    [InlineData(200, """{"data":{"endpoints":[{"provider_name":"Wafer","pricing":{"prompt":"1","completion":"1"}},{"provider_name":"Wafer","pricing":{"prompt":"2","completion":"1"}}]}}""")]
    [InlineData(200, """{"data":{"endpoints":[{"provider_name":"Wafer","pricing":{"prompt":"1","completion":"1","overrides":[{}]}}]}}""")]
    public async Task MissingInvalidOrAmbiguousPricingDoesNotDiscardTheResolution(int status, string body)
    {
        await using var application = CreateApplication(new DeterministicServicesHandler { PricingStatus = (HttpStatusCode)status, PricingBody = body });
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" });
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("diagnostics").GetProperty("costEstimate").ValueKind);
        Assert.Equal(0.0000215m, result.GetProperty("diagnostics").GetProperty("usage").GetProperty("cost").GetDecimal());
    }

    [Theory]
    [InlineData("timeout")]
    [InlineData("network")]
    public async Task PricingLookupFailuresKeepSuccessfulResolutionAndUsage(string failure)
    {
        await using var application = CreateApplication(new DeterministicServicesHandler
        {
            BeforeRespondAsync = (path, _) => path.EndsWith("/endpoints", StringComparison.Ordinal)
                ? Task.FromException(failure == "timeout" ? new OperationCanceledException() : new HttpRequestException())
                : Task.CompletedTask
        });
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" });
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("diagnostics").GetProperty("costEstimate").ValueKind);
    }

    [Fact]
    public async Task ModelInputExcludesBrowserCapabilityIdentitiesAndCaptureBookkeeping()
    {
        var handler = new DeterministicServicesHandler();
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" });
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
        using var response = await client.PostAsJsonAsync("/pages/page-1/resolve", new { instruction = "Click Save", documentId = "document-1" });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal("invalid_browser_capture", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    private static string ProviderSelection(string selection) => JsonSerializer.Serialize(new
    {
        id = "generation-1",
        choices = new[] { new { finish_reason = "stop", message = new { content = selection } } }
    });

    private static WebApplicationFactory<HealthController> CreateApplication(DeterministicServicesHandler handler, Dictionary<string, string?>? settings = null) =>
        new WebApplicationFactory<HealthController>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(
                new Dictionary<string, string?> { ["OpenRouter:ApiKey"] = "test-token" }).AddInMemoryCollection(settings ?? []));
            builder.ConfigureServices(services =>
            {
                services.AddHttpClient("browser").ConfigurePrimaryHttpMessageHandler(() => handler);
                services.AddHttpClient("openrouter").ConfigurePrimaryHttpMessageHandler(() => handler);
            });
        });
}
