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

public sealed class ProviderPricingTests
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
