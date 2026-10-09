using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;
using Xpathed.Resolver.Services;

namespace Xpathed.Resolver.Tests;

public sealed class ImageRoutingGatewayTests
{
    private const string Success = """
        {"model":"typesafe/jev-1.13-20260917","provider":"TypeSafe","id":"gen-dec-fixture",
         "answers":{"pixel_content":{"type":"noul","noul":0.05},"rendered_appearance":{"type":"noul","noul":0.02}},
         "usage":{"input_tokens":500,"output_tokens":40,"cost":0.000021}}
        """;

    [Fact]
    public async Task UsesPinnedDecisionsEndpointAndPreservesSeparateUsage()
    {
        var posts = 0;
        using var fixture = new Fixture(
            async (request, token) =>
            {
                if (request.Method == HttpMethod.Get)
                {
                    Assert.Equal("/api/v1/models/typesafe/jev-1.13/endpoints", request.RequestUri!.AbsolutePath);
                    return Response("{}", HttpStatusCode.NotFound);
                }
                posts++;
                Assert.Equal("/api/alpha/decisions", request.RequestUri!.AbsolutePath);
                Assert.Equal("Bearer", request.Headers.Authorization?.Scheme);
                Assert.Equal("fixture-key", request.Headers.Authorization?.Parameter);
                Assert.Equal("false", Assert.Single(request.Headers.GetValues("X-OpenRouter-Cache")));
                using var payload = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
                var body = payload.RootElement;
                Assert.Equal("typesafe/jev-1.13", body.GetProperty("model").GetString());
                Assert.Equal(
                    "typesafe",
                    Assert.Single(body.GetProperty("provider").GetProperty("only").EnumerateArray()).GetString()
                );
                Assert.False(body.GetProperty("provider").GetProperty("allow_fallbacks").GetBoolean());
                Assert.Equal("Click Save", body.GetProperty("state").GetProperty("instruction").GetString());
                Assert.Equal(2, body.GetProperty("questions").EnumerateObject().Count());
                Assert.False(body.TryGetProperty("messages", out _));
                Assert.False(body.TryGetProperty("max_tokens", out _));
                return Response(Success);
            }
        );
        ResolutionDiagnostics? observed = null;
        var result = await fixture.Gateway.DecideImageAsync(
            """{"instruction":"Click Save"}""",
            CancellationToken.None,
            value => observed = value
        );
        Assert.Null(result.Diagnostics.Code);
        Assert.Equal(1, posts);
        Assert.Equal("gen-dec-fixture", observed!.GenerationId);
        Assert.Equal(500, observed.Usage!.InputTokens);
        Assert.Equal(40, observed.Usage.OutputTokens);
        Assert.Equal(540, observed.Usage.TotalTokens);
        Assert.Equal(0.000021m, observed.Usage.Cost);
        Assert.False(ImageRoutingPolicy.Decide(result.Content).IncludeImage);
    }

    [Theory]
    [InlineData("wrong_model", "provider_identity_mismatch")]
    [InlineData("missing_model", "provider_malformed_response")]
    [InlineData("wrong_provider", "provider_identity_mismatch")]
    [InlineData("missing_answer", "provider_malformed_response")]
    [InlineData("invalid_probability", "provider_malformed_response")]
    [InlineData("missing_tokens", "provider_malformed_response")]
    [InlineData("overflow_tokens", "provider_malformed_response")]
    [InlineData("invalid_provider_type", "provider_malformed_response")]
    [InlineData("invalid_id_type", "provider_malformed_response")]
    public async Task InvalidDecisionRetainsAccountingButCannotDisableImage(string defect, string expected)
    {
        var body = JsonNode.Parse(Success)!;
        switch (defect)
        {
            case "wrong_model":
                body["model"] = "typesafe/jev-unknown";
                break;
            case "missing_model":
                body.AsObject().Remove("model");
                break;
            case "wrong_provider":
                body["provider"] = "another-provider";
                break;
            case "missing_answer":
                body["answers"]!.AsObject().Remove("pixel_content");
                break;
            case "invalid_probability":
                body["answers"]!["pixel_content"]!["noul"] = 2;
                break;
            case "missing_tokens":
                body["usage"]!.AsObject().Remove("input_tokens");
                break;
            case "overflow_tokens":
                body["usage"]!["input_tokens"] = long.MaxValue;
                break;
            case "invalid_provider_type":
                body["provider"] = 7;
                break;
            case "invalid_id_type":
                body["id"] = 7;
                break;
        }
        using var fixture = new Fixture(
            (request, _) =>
                Task.FromResult(
                    request.Method == HttpMethod.Get
                        ? Response("{}", HttpStatusCode.NotFound)
                        : Response(body.ToJsonString())
                )
        );
        ResolutionDiagnostics? observed = null;
        var result = await fixture.Gateway.DecideImageAsync("{}", CancellationToken.None, value => observed = value);
        Assert.Equal(expected, result.Diagnostics.Code);
        Assert.Null(result.Content);
        Assert.Equal(0.000021m, observed!.Usage!.Cost);
        Assert.True(ImageRoutingPolicy.Decide(result.Content).IncludeImage);
    }

    [Theory]
    [InlineData(401, "provider_authentication")]
    [InlineData(402, "provider_credits")]
    [InlineData(429, "provider_rate_limited")]
    [InlineData(529, "provider_unavailable")]
    public async Task ProviderErrorsMakeOneAttemptAndPreserveReportedUsage(int status, string expected)
    {
        var posts = 0;
        using var fixture = new Fixture(
            (request, _) =>
            {
                if (request.Method == HttpMethod.Get)
                {
                    return Task.FromResult(Response("{}", HttpStatusCode.NotFound));
                }
                posts++;
                var body = JsonNode.Parse(Success)!;
                body["error"] = new JsonObject { ["code"] = status, ["message"] = "synthetic-secret-error" };
                return Task.FromResult(Response(body.ToJsonString(), (HttpStatusCode)status));
            }
        );
        var result = await fixture.Gateway.DecideImageAsync("{}", CancellationToken.None);
        Assert.Equal(1, posts);
        Assert.Equal(expected, result.Diagnostics.Code);
        Assert.Equal(0.000021m, result.Diagnostics.Usage!.Cost);
        Assert.Null(result.Diagnostics.Message);
        Assert.Null(result.Content);
    }

    [Fact]
    public async Task OptionalProviderGenerationAndCostRemainUnknownWithoutLosingValidDecision()
    {
        var body = JsonNode.Parse(Success)!;
        body.AsObject().Remove("provider");
        body.AsObject().Remove("id");
        body["usage"]!.AsObject().Remove("cost");
        using var fixture = new Fixture((_, _) => Task.FromResult(Response(body.ToJsonString())));
        var result = await fixture.Gateway.DecideImageAsync("{}", CancellationToken.None);
        Assert.Null(result.Diagnostics.Code);
        Assert.Null(result.Diagnostics.Provider);
        Assert.Null(result.Diagnostics.GenerationId);
        Assert.Null(result.Diagnostics.Usage!.Cost);
        Assert.Null(result.Diagnostics.CostEstimate);
        Assert.Equal(500, result.Diagnostics.Usage.InputTokens);
        Assert.False(ImageRoutingPolicy.Decide(result.Content).IncludeImage);
    }

    [Fact]
    public async Task MissingReportedCostRemainsUnknownWhilePricingUsesCanonicalModel()
    {
        var body = JsonNode.Parse(Success)!;
        body["model"] = "typesafe/jev-1.13";
        body["usage"]!.AsObject().Remove("cost");
        using var fixture = new Fixture(
            (request, _) =>
                Task.FromResult(
                    request.Method == HttpMethod.Get
                        ? Response(
                            """{"data":{"endpoints":[{"provider_name":"TypeSafe","pricing":{"prompt":"0.000000042","completion":"0"}}]}}"""
                        )
                        : Response(body.ToJsonString())
                )
        );
        var result = await fixture.Gateway.DecideImageAsync("{}", CancellationToken.None);
        Assert.Null(result.Diagnostics.Code);
        Assert.Null(result.Diagnostics.Usage!.Cost);
        Assert.Equal(0.000021m, result.Diagnostics.CostEstimate!.TotalCost);
    }

    [Fact]
    public async Task RoutingSharesSynchronousAdmissionWithFinalModel()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var posts = 0;
        using var fixture = new Fixture(
            async (request, token) =>
            {
                if (request.Method == HttpMethod.Get)
                {
                    return Response("{}", HttpStatusCode.NotFound);
                }
                posts++;
                entered.SetResult();
                await release.Task.WaitAsync(token);
                return Response(Success);
            }
        );
        var pending = fixture.Gateway.DecideImageAsync("{}", CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        try
        {
            var rejected = Assert.Throws<ApiException>(() =>
            {
                _ = fixture.Gateway.CompleteAsync("{}", CancellationToken.None);
            });
            Assert.Equal("model_usage_limited", rejected.Code);
            Assert.Equal(1, posts);
        }
        finally
        {
            release.TrySetResult();
        }
        Assert.Null((await pending).Diagnostics.Code);
    }

    [Fact]
    public async Task RouterTimeoutIsBoundedAndDoesNotRetry()
    {
        var posts = 0;
        using var fixture = new Fixture(
            async (_, token) =>
            {
                posts++;
                await Task.Delay(Timeout.InfiniteTimeSpan, token);
                return Response(Success);
            }
        );
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            fixture.Gateway.DecideImageAsync("{}", CancellationToken.None)
        );
        Assert.Equal(1, posts);
    }

    private static HttpResponseMessage Response(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json") };

    private sealed class Fixture : IDisposable
    {
        private readonly Requests requests;
        private readonly MemoryCache cache = new(new MemoryCacheOptions());
        private readonly ModelUsageLimits limits;
        internal OpenRouterGateway Gateway { get; }

        internal Fixture(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handle)
        {
            requests = new Requests(handle);
            var configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(
                    new Dictionary<string, string?>
                    {
                        ["OpenRouter:ApiKey"] = "fixture-key",
                        ["OpenRouter:BaseUrl"] = "http://provider.test/api/v1/",
                        ["ModelUsage:ConcurrentCalls"] = "1",
                        ["ModelUsage:CallsPerMinute"] = "100",
                        ["ModelUsage:CallsPerDay"] = "100",
                    }
                )
                .Build();
            limits = new ModelUsageLimits(configuration);
            Gateway = new OpenRouterGateway(requests, configuration, cache, limits);
        }

        public void Dispose()
        {
            requests.Dispose();
            cache.Dispose();
            limits.Dispose();
        }
    }

    private sealed class Requests(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handle)
        : HttpMessageHandler,
            IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(this, false);

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken
        ) => handle(request, cancellationToken);
    }
}
