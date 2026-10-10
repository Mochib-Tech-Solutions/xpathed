using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Xpathed.Common.Contracts;
using Xpathed.Resolver.Services;
using static Xpathed.Resolver.Tests.DeterministicServicesHandler;
using static Xpathed.Resolver.Tests.ResolverTestApplication;

namespace Xpathed.Resolver.Tests;

public sealed class ProviderContractTests
{
    [Theory]
    [InlineData("deepseek/deepseek-v4.1-flash", "Wafer")]
    [InlineData("openai/gpt-6-luna", "Azure")]
    [InlineData("google/gemini-3.8-flash", "Google")]
    [InlineData("anthropic/claude-sonnet-4.6", "Anthropic")]
    [InlineData("example/new-model:free", "New Provider")]
    public async Task CurrentViewReturnsAndCachesPricingForTheReportedModel(string model, string provider)
    {
        var pricingCalls = 0;
        var free = model.EndsWith(":free", StringComparison.Ordinal);
        var body = JsonNode.Parse(BilledSelection())!;
        body["model"] = model;
        body["provider"] = provider;
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = body.ToJsonString(),
            PricingBody = JsonSerializer.Serialize(
                new
                {
                    data = new
                    {
                        endpoints = new[]
                        {
                            new
                            {
                                provider_name = provider,
                                pricing = new
                                {
                                    prompt = free ? "0" : "0.00000005",
                                    completion = free ? "0" : "0.0000006",
                                },
                            },
                        },
                    },
                }
            ),
            BeforeRespondAsync = (path, _) =>
            {
                if (path.EndsWith("/endpoints", StringComparison.Ordinal))
                {
                    Assert.Equal($"/api/v1/models/{model}/endpoints", Uri.UnescapeDataString(path));
                    Interlocked.Increment(ref pricingCalls);
                }
                return Task.CompletedTask;
            },
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        DateTimeOffset? fetchedAt = null;
        for (var attempt = 0; attempt < 2; attempt++)
        {
            body["usage"]!["prompt_tokens"] = 140 * (attempt + 1);
            body["usage"]!["total_tokens"] = 140 * (attempt + 1) + 15;
            handler.ProviderBody = body.ToJsonString();
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
            var estimate = diagnostics.GetProperty("costEstimate");
            Assert.Equal(JsonValueKind.Object, estimate.ValueKind);
            Assert.Equal(free ? 0m : 0.05m, estimate.GetProperty("inputPricePerMillion").GetDecimal());
            Assert.Equal(free ? 0m : 0.6m, estimate.GetProperty("outputPricePerMillion").GetDecimal());
            Assert.Equal(free ? 0m : 0.000007m * (attempt + 1), estimate.GetProperty("inputCost").GetDecimal());
            Assert.Equal(free ? 0m : 0.000009m, estimate.GetProperty("outputCost").GetDecimal());
            Assert.Equal(0m, estimate.GetProperty("requestCost").GetDecimal());
            Assert.Equal(
                free ? 0m
                    : attempt == 0 ? 0.000016m
                    : 0.000023m,
                estimate.GetProperty("totalCost").GetDecimal()
            );
            Assert.Equal(0.0000215m, diagnostics.GetProperty("usage").GetProperty("cost").GetDecimal());
            fetchedAt ??= estimate.GetProperty("pricingFetchedAt").GetDateTimeOffset();
            Assert.Equal(fetchedAt.Value, estimate.GetProperty("pricingFetchedAt").GetDateTimeOffset());
        }
        Assert.Equal(1, pricingCalls);
        Assert.Equal(2, handler.ProviderRequestCount);
    }

    [Fact]
    public async Task PendingPricingDoesNotDelayResolutionOrRepeatTheLookup()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var pricingCalls = 0;
        var handler = new DeterministicServicesHandler
        {
            BeforeRespondAsync = async (path, token) =>
            {
                if (path.EndsWith("/endpoints", StringComparison.Ordinal))
                {
                    Interlocked.Increment(ref pricingCalls);
                    started.TrySetResult();
                    await release.Task.WaitAsync(token);
                }
            },
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        try
        {
            var pending = client.PostAsJsonAsync(
                "/pages/page-1/resolve",
                new
                {
                    instruction = "Click Save",
                    documentId = "document-1",
                    imageMode = "text_only",
                }
            );
            await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            using var first = await pending.WaitAsync(TimeSpan.FromSeconds(1));
            using var second = await client
                .PostAsJsonAsync(
                    "/pages/page-1/resolve",
                    new
                    {
                        instruction = "Click Save",
                        documentId = "document-1",
                        imageMode = "text_only",
                    }
                )
                .WaitAsync(TimeSpan.FromSeconds(1));
            foreach (var response in new[] { first, second })
            {
                var result = await response.Content.ReadFromJsonAsync<JsonElement>();
                Assert.Equal("found", result.GetProperty("outcome").GetString());
                var diagnostics = result.GetProperty("diagnostics");
                Assert.Equal(JsonValueKind.Null, diagnostics.GetProperty("costEstimate").ValueKind);
                Assert.Equal(0.0000215m, diagnostics.GetProperty("usage").GetProperty("cost").GetDecimal());
            }
            Assert.Equal(1, pricingCalls);
            Assert.Equal(2, handler.SelectionRequestCount);
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Fact]
    public async Task UnavailablePricingIsCachedWithoutLosingReportedCharges()
    {
        var pricingCalls = 0;
        var handler = new DeterministicServicesHandler
        {
            PricingStatus = HttpStatusCode.ServiceUnavailable,
            BeforeRespondAsync = (path, _) =>
            {
                if (path.EndsWith("/endpoints", StringComparison.Ordinal))
                {
                    Interlocked.Increment(ref pricingCalls);
                }
                return Task.CompletedTask;
            },
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        for (var attempt = 0; attempt < 2; attempt++)
        {
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
            Assert.Equal(JsonValueKind.Null, diagnostics.GetProperty("costEstimate").ValueKind);
            Assert.Equal(0.0000215m, diagnostics.GetProperty("usage").GetProperty("cost").GetDecimal());
        }
        Assert.Equal(1, pricingCalls);
    }

    [Fact]
    public async Task PricingCacheSeparatesModelsAndProviders()
    {
        var pricingCalls = 0;
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            BeforeRespondAsync = (path, _) =>
            {
                if (path.EndsWith("/endpoints", StringComparison.Ordinal))
                {
                    pricingCalls++;
                }
                return Task.CompletedTask;
            },
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        var completion = JsonNode.Parse(BilledSelection())!;
        var pricing = JsonNode.Parse(handler.PricingBody)!;
        foreach (
            var (model, provider, rate, expected) in new[]
            {
                ("example/first", "Provider A", "0.000001", 1m),
                ("example/second", "Provider A", "0.000002", 2m),
                ("example/second", "Provider B", "0.000003", 3m),
            }
        )
        {
            completion["model"] = model;
            completion["provider"] = provider;
            handler.ProviderBody = completion.ToJsonString();
            pricing["data"]!["endpoints"]![0]!["provider_name"] = provider;
            pricing["data"]!["endpoints"]![0]!["pricing"]!["prompt"] = rate;
            handler.PricingBody = pricing.ToJsonString();
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
            Assert.Equal(
                expected,
                result
                    .GetProperty("diagnostics")
                    .GetProperty("costEstimate")
                    .GetProperty("inputPricePerMillion")
                    .GetDecimal()
            );
        }
        Assert.Equal(3, pricingCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DisconnectedProviderChargesAreLoggedOnceWithoutLateSelection(bool duringValidation)
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var logs = new AccountingLogProvider();
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = BilledSelection(),
            BeforeRespondAsync = async (path, token) =>
            {
                if (path.EndsWith(duringValidation ? "/selections" : "/chat/completions", StringComparison.Ordinal))
                {
                    started.TrySetResult();
                    await release.Task.WaitAsync(token);
                }
            },
        };
        await using var application = CreateApplication(handler, logs: logs);
        using var client = application.CreateClient();
        using var cancellation = new CancellationTokenSource();
        var request = client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                imageMode = "text_only",
            },
            cancellation.Token
        );
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await request);
        Assert.Equal(0, handler.SelectionRequestCount);
        release.SetResult();
        await logs.Recorded.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var entry = Assert.Single(logs.Entries).ToDictionary(pair => pair.Key, pair => pair.Value);
        Assert.Equal(0.0000215m, entry["ReportedUsd"]);
        Assert.Equal("generation-1", entry["GenerationId"]);
        Assert.Equal("completed", entry["AccountingStatus"]);
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal(0, handler.SelectionRequestCount);
    }

    [Theory]
    [InlineData("/pages/page-1/selections")]
    public async Task CurrentViewTransportTimeoutRetainsChargesAlreadyReported(string slowPath)
    {
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = BilledSelection(),
            BeforeRespondAsync = (path, _) =>
            {
                if (path == slowPath)
                {
                    throw new TaskCanceledException("Controlled browser transport timeout");
                }
                return Task.CompletedTask;
            },
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
        Assert.Equal("browser_timeout", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(
            0.0000215m,
            result.GetProperty("diagnostics").GetProperty("usage").GetProperty("cost").GetDecimal()
        );
        Assert.Equal("completed", result.GetProperty("diagnostics").GetProperty("providerAccounting").GetString());
        Assert.Empty(result.GetProperty("actions").EnumerateArray());
    }

    [Fact]
    public async Task ConfigurationIdentityDescribesEffectiveSettingsWithoutCredentialsOrPageInput()
    {
        var handler = new DeterministicServicesHandler { ProviderBody = BilledSelection() };
        await using var application = CreateApplication(
            handler,
            new Dictionary<string, string?>
            {
                ["OpenRouter:BaseUrl"] = "http://configured-provider.test/api/v1",
                ["OpenRouter:Model"] = "configured/model",
                ["OpenRouter:Provider"] = "configured-route",
                ["OpenRouter:TimeoutSeconds"] = "47",
                ["OpenRouter:ApiKey"] = "configuration-secret-canary",
            }
        );
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click the unique instruction-canary",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        var effective = JsonSerializer.SerializeToElement(
            application.Services.GetRequiredService<OpenRouterGateway>().DescribeConfiguration()
        );
        Assert.Equal("http://configured-provider.test/api/v1/", effective.GetProperty("endpoint").GetString());
        Assert.Equal("47", effective.GetProperty("timeoutSeconds").GetString());
        Assert.Equal(16, effective.GetProperty("maximumActions").GetInt32());
        Assert.False(effective.GetProperty("responseCache").GetBoolean());
        var request = effective.GetProperty("request");
        Assert.Equal("configured/model", request.GetProperty("model").GetString());
        Assert.Equal("configured-route", request.GetProperty("provider").GetProperty("only")[0].GetString());
        Assert.Equal(4096, request.GetProperty("max_tokens").GetInt32());
        Assert.False(request.GetProperty("reasoning").GetProperty("enabled").GetBoolean());
        Assert.Equal(string.Empty, request.GetProperty("messages")[1].GetProperty("content").GetString());
        Assert.Equal(
            handler.ModelRequest.GetProperty("messages")[0].GetProperty("content").GetString(),
            request.GetProperty("messages")[0].GetProperty("content").GetString()
        );
        Assert.DoesNotContain("configuration-secret-canary", effective.GetRawText(), StringComparison.Ordinal);
        Assert.DoesNotContain("instruction-canary", effective.GetRawText(), StringComparison.Ordinal);
        Assert.DoesNotContain("button-save", effective.GetRawText(), StringComparison.Ordinal);
        Assert.Equal(
            result.GetProperty("configurationId").GetString(),
            Convert.ToHexStringLower(
                System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(effective.GetRawText()))
            )
        );
    }

    [Theory]
    [InlineData("API_KEY=violet-cactus-782", "[redacted]")]
    [InlineData("Bearer violet-cactus-782", "[redacted]")]
    [InlineData(
        "https://alice:violet-cactus-782@example.org/settings?auth=violet-cactus-782#violet-cactus-782",
        "https://example.org/settings"
    )]
    public async Task LateAccountingSanitizesCredentialBearingProviderMetadata(string metadata, string expected)
    {
        var logs = new AccountingLogProvider();
        await using var application = CreateApplication(new DeterministicServicesHandler(), logs: logs);
        var accounting = application.Services.GetRequiredService<ProviderAccounting>();
        accounting.Record(
            new ResolutionDiagnostics
            {
                GenerationId = metadata,
                Model = metadata,
                Provider = metadata,
            },
            "trace-1",
            "attempt-1",
            "configuration-1"
        );
        var entry = Assert.Single(logs.Entries).ToDictionary(pair => pair.Key, pair => pair.Value);
        Assert.Equal(expected, entry["GenerationId"]);
        Assert.Equal(expected, entry["Model"]);
        Assert.Equal(expected, entry["Provider"]);
        Assert.DoesNotContain("violet-cactus-782", JsonSerializer.Serialize(entry), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ConfigurationFailureDoesNotCaptureOrCallProvider()
    {
        var handler = new DeterministicServicesHandler();
        await using var application = CreateApplication(
            handler,
            new Dictionary<string, string?> { ["OpenRouter:ApiKey"] = null }
        );
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
        Assert.Equal("provider_not_configured", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(0, handler.CaptureRequestCount);
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData(401, "{}", "provider_authentication")]
    [InlineData(429, "{}", "provider_rate_limited")]
    [InlineData(408, "{}", "provider_timeout")]
    [InlineData(503, "{}", "provider_unavailable")]
    [InlineData(
        200,
        """{"error":{"code":401,"metadata":{"error_type":"authentication"}}}""",
        "provider_authentication"
    )]
    [InlineData(
        200,
        """{"choices":[{"finish_reason":"error","error":{"code":429,"metadata":{"error_type":"rate_limit_exceeded"}}}]}""",
        "provider_rate_limited"
    )]
    [InlineData(200, "{", "provider_malformed_response")]
    [InlineData(200, "{}", "provider_malformed_response")]
    [InlineData(200, """{"choices":[]}""", "provider_malformed_response")]
    [InlineData(200, """{"choices":[{"finish_reason":"stop","message":{"content":""}}]}""", "provider_empty_response")]
    [InlineData(
        200,
        """{"choices":[{"finish_reason":"length","message":{"content":""}}]}""",
        "provider_truncated_response"
    )]
    [InlineData(
        200,
        """{"choices":[{"finish_reason":"content_filter","message":{"content":null,"refusal":"Declined"}}]}""",
        "provider_refused"
    )]
    public async Task ProviderFailuresRemainDistinctFromSemanticAbsence(int status, string body, string code)
    {
        await using var application = CreateApplication(
            new DeterministicServicesHandler { ProviderStatus = (HttpStatusCode)status, ProviderBody = body }
        );
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
        Assert.Equal(code, result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("target").ValueKind);
    }

    [Theory]
    [InlineData("OpenRouter:ApiKey", null, "provider_not_configured")]
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
    public async Task ConfigurationIdentityDependsOnSettingsAndExcludesKeyAndInstruction(
        string key,
        string value,
        string instruction,
        bool sameConfiguration
    )
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
            return result.GetProperty("configurationId").GetString();
        }
    }

    [Fact]
    public async Task DefaultDeepSeekRequestDisablesReasoningAndRecordsTheEffectiveSettings()
    {
        var handler = new DeterministicServicesHandler();
        await using var application = CreateApplication(
            handler,
            new Dictionary<string, string?> { ["OpenRouter:Model"] = null, ["OpenRouter:Provider"] = null }
        );
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
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        var request = handler.ModelRequest;
        Assert.Equal("deepseek/deepseek-v4.1-flash", request.GetProperty("model").GetString());
        Assert.Equal("inference-net/fp8", request.GetProperty("provider").GetProperty("only")[0].GetString());
        Assert.False(request.GetProperty("reasoning").GetProperty("enabled").GetBoolean());
        Assert.False(handler.CaptureRequest.GetProperty("includeImage").GetBoolean());
        Assert.False(request.GetProperty("provider").GetProperty("allow_fallbacks").GetBoolean());
        Assert.Equal(4096, request.GetProperty("max_tokens").GetInt32());
        Assert.True(
            request.GetProperty("response_format").GetProperty("json_schema").GetProperty("strict").GetBoolean()
        );
        var effective = JsonSerializer.SerializeToElement(
            application.Services.GetRequiredService<OpenRouterGateway>().DescribeConfiguration()
        );
        Assert.Equal(
            request.GetProperty("reasoning").GetRawText(),
            effective.GetProperty("request").GetProperty("reasoning").GetRawText()
        );
        Assert.Equal(
            result.GetProperty("configurationId").GetString(),
            Convert.ToHexStringLower(
                System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(effective.GetRawText()))
            )
        );
        Assert.Equal(1, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData("deepseek/deepseek-v4.1-flash", "wafer")]
    [InlineData("openai/gpt-6-luna", "openai")]
    public async Task ProviderRequestPinsSupportedSettingsAndPreservesUnicodeLabels(string model, string provider)
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["candidates"]![0]!["label"] = "Sauvegarder 東京";
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
        await using var application = CreateApplication(
            handler,
            new Dictionary<string, string?> { ["OpenRouter:Model"] = model, ["OpenRouter:Provider"] = provider }
        );
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
        var body = handler.ModelRequest;
        Assert.Equal(model, body.GetProperty("model").GetString());
        Assert.False(body.GetProperty("reasoning").GetProperty("enabled").GetBoolean());
        Assert.False(body.TryGetProperty("service_tier", out _));
        Assert.Equal(4096, body.GetProperty("max_tokens").GetInt32());
        Assert.Equal(provider, body.GetProperty("provider").GetProperty("only")[0].GetString());
        Assert.False(body.GetProperty("provider").TryGetProperty("max_price", out _));
        Assert.False(body.GetProperty("provider").GetProperty("allow_fallbacks").GetBoolean());
        Assert.True(body.GetProperty("provider").GetProperty("require_parameters").GetBoolean());
        Assert.True(body.GetProperty("response_format").GetProperty("json_schema").GetProperty("strict").GetBoolean());
        Assert.False(body.TryGetProperty("tools", out _));
        Assert.False(body.TryGetProperty("temperature", out _));
        Assert.Contains(
            "東京",
            body.GetProperty("messages")[1].GetProperty("content").GetString(),
            StringComparison.Ordinal
        );
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
                """,
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
    [InlineData(
        200,
        """{"data":{"endpoints":[{"provider_name":"Other","pricing":{"prompt":"1","completion":"1"}}]}}"""
    )]
    [InlineData(
        200,
        """{"data":{"endpoints":[{"provider_name":"Wafer","pricing":{"prompt":"-1","completion":"1"}}]}}"""
    )]
    [InlineData(200, """{"data":{"endpoints":[{"provider_name":"Wafer","pricing":{"prompt":"1"}}]}}""")]
    [InlineData(
        200,
        """{"data":{"endpoints":[{"provider_name":"Wafer","pricing":{"prompt":"1","completion":"1"}},{"provider_name":"Wafer","pricing":{"prompt":"2","completion":"1"}}]}}"""
    )]
    [InlineData(
        200,
        """{"data":{"endpoints":[{"provider_name":"Wafer","pricing":{"prompt":"1","completion":"1","overrides":[{}]}}]}}"""
    )]
    public async Task MissingInvalidOrAmbiguousPricingDoesNotDiscardTheResolution(int status, string body)
    {
        {
            await using var application = CreateApplication(
                new DeterministicServicesHandler
                {
                    PricingStatus = (HttpStatusCode)status,
                    PricingBody = body,
                    CaptureBody = CurrentViewCapture(),
                    ProviderBody = BilledSelection(),
                }
            );
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
            Assert.Equal(JsonValueKind.Null, result.GetProperty("diagnostics").GetProperty("costEstimate").ValueKind);
            Assert.Equal(
                0.0000215m,
                result.GetProperty("diagnostics").GetProperty("usage").GetProperty("cost").GetDecimal()
            );
        }
    }

    [Theory]
    [InlineData("timeout")]
    [InlineData("network")]
    public async Task PricingLookupFailuresKeepSuccessfulResolutionAndUsage(string failure)
    {
        {
            await using var application = CreateApplication(
                new DeterministicServicesHandler
                {
                    CaptureBody = CurrentViewCapture(),
                    ProviderBody = BilledSelection(),
                    BeforeRespondAsync = (path, _) =>
                        path.EndsWith("/endpoints", StringComparison.Ordinal)
                            ? Task.FromException(
                                failure == "timeout" ? new OperationCanceledException() : new HttpRequestException()
                            )
                            : Task.CompletedTask,
                }
            );
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
            Assert.Equal(JsonValueKind.Null, result.GetProperty("diagnostics").GetProperty("costEstimate").ValueKind);
        }
    }
}
