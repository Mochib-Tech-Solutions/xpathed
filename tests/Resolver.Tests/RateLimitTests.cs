using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xpathed.Resolver.Controllers;

namespace Xpathed.Resolver.Tests;

public sealed class RateLimitTests
{
    [Fact]
    public async Task HttpQuotaRejectsBeforeProviderAndLeavesHealthAvailable()
    {
        var handler = new DeterministicServicesHandler();
        await using var app = Application(handler, "RateLimits:RequestsPerMinute", "1");
        using var client = app.CreateClient();
        using var first = await Resolve(client);
        Assert.Equal(
            "found",
            (await first.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("outcome").GetString()
        );
        client.DefaultRequestHeaders.Add("X-Forwarded-For", "198.51.100.44");
        using var rejected = await Resolve(client, diagnostic: true);
        Assert.Equal(HttpStatusCode.TooManyRequests, rejected.StatusCode);
        Assert.Equal(
            "request_rate_limited",
            (await rejected.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString()
        );
        Assert.True(rejected.Headers.RetryAfter?.Delta > TimeSpan.Zero);
        Assert.Equal(1, handler.ProviderRequestCount);
        using var health = await client.GetAsync("/health");
        Assert.Equal(HttpStatusCode.OK, health.StatusCode);
    }

    [Theory]
    [InlineData("ModelUsage:CallsPerMinute")]
    [InlineData("ModelUsage:CallsPerDay")]
    public async Task ModelQuotaIsSharedByPublicAndDiagnosticRequestsAndCountsFailedAttempts(string setting)
    {
        var handler = new DeterministicServicesHandler { ProviderStatus = HttpStatusCode.ServiceUnavailable };
        await using var app = Application(handler, setting, "1");
        using var client = app.CreateClient();
        using var first = await Resolve(client);
        var attempted = await first.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", attempted.GetProperty("outcome").GetString());
        Assert.Equal(1, attempted.GetProperty("diagnostics").GetProperty("modelCalls").GetInt32());
        client.DefaultRequestHeaders.Add("X-Forwarded-For", "198.51.100.99");
        using var rejected = await Resolve(client, diagnostic: true);
        var result = (await rejected.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("result");
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        var diagnostics = result.GetProperty("diagnostics");
        Assert.Equal("model_usage_limited", diagnostics.GetProperty("code").GetString());
        Assert.Equal(0, diagnostics.GetProperty("modelCalls").GetInt32());
        Assert.Equal(JsonValueKind.Null, diagnostics.GetProperty("usage").ValueKind);
        Assert.Equal(JsonValueKind.Null, diagnostics.GetProperty("providerAccounting").ValueKind);
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal(0, handler.SelectionRequestCount);
        for (var attempt = 0; attempt < 40; attempt++)
        {
            using var repeated = await Resolve(client);
            var denied = (await repeated.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("diagnostics");
            Assert.Equal("model_usage_limited", denied.GetProperty("code").GetString());
            Assert.Equal(0, denied.GetProperty("modelCalls").GetInt32());
        }
        Assert.Equal(1, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData("RateLimits:RequestsPerMinute")]
    [InlineData("RateLimits:ConcurrentRequests")]
    [InlineData("ModelUsage:ConcurrentCalls")]
    [InlineData("ModelUsage:CallsPerMinute")]
    [InlineData("ModelUsage:CallsPerDay")]
    public async Task ZeroLimitsFailConfigurationInsteadOfDisablingProtection(string setting)
    {
        await using var app = Application(new DeterministicServicesHandler(), setting, "0");
        Assert.Throws<ArgumentOutOfRangeException>(() => app.CreateClient());
    }

    [Fact]
    public async Task ProviderFailureReleasesConcurrencyButDoesNotRefundCallQuota()
    {
        var handler = new DeterministicServicesHandler { ProviderStatus = HttpStatusCode.ServiceUnavailable };
        await using var app = Application(handler, "ModelUsage:ConcurrentCalls", "1");
        using var client = app.CreateClient();
        for (var attempt = 0; attempt < 3; attempt++)
        {
            using var response = await Resolve(client);
            var diagnostics = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("diagnostics");
            Assert.Equal("provider_unavailable", diagnostics.GetProperty("code").GetString());
            Assert.Equal(1, diagnostics.GetProperty("modelCalls").GetInt32());
        }
        Assert.Equal(3, handler.ProviderRequestCount);
    }

    [Fact]
    public async Task DisconnectDoesNotReleaseModelCapacityBeforeProviderCompletes()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new DeterministicServicesHandler
        {
            BeforeRespondAsync = async (path, token) =>
            {
                if (path == "/api/v1/chat/completions")
                {
                    started.TrySetResult();
                    await finish.Task.WaitAsync(token);
                }
            },
        };
        await using var app = Application(handler, "ModelUsage:ConcurrentCalls", "1");
        using var client = app.CreateClient();
        using var cancellation = new CancellationTokenSource();
        var pending = Resolve(client, token: cancellation.Token);
        try
        {
            await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
            using var rejected = await Resolve(client);
            var result = await rejected.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("model_usage_limited", result.GetProperty("diagnostics").GetProperty("code").GetString());
            Assert.Equal(0, result.GetProperty("diagnostics").GetProperty("modelCalls").GetInt32());
        }
        finally
        {
            finish.TrySetResult();
        }
        // The released slot is usable after the detached provider attempt has ended.
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (true)
        {
            using var response = await Resolve(client);
            var result = await response.Content.ReadFromJsonAsync<JsonElement>();
            if (result.GetProperty("outcome").GetString() == "found")
            {
                Assert.Equal(
                    0.0000215m,
                    result.GetProperty("diagnostics").GetProperty("usage").GetProperty("cost").GetDecimal()
                );
                break;
            }
            Assert.True(DateTime.UtcNow < deadline, "Provider capacity was not released after completion.");
            await Task.Delay(10);
        }
        Assert.Equal(2, handler.ProviderRequestCount);
        Assert.Equal(1, handler.SelectionRequestCount);
    }

    private static Task<HttpResponseMessage> Resolve(
        HttpClient client,
        bool diagnostic = false,
        CancellationToken token = default
    )
    {
        client.DefaultRequestHeaders.Remove("X-Xpathed-Attempt-Id");
        client.DefaultRequestHeaders.Add("X-Xpathed-Attempt-Id", Guid.NewGuid().ToString("N"));
        return client.PostAsJsonAsync(
            (diagnostic ? "/internal" : "") + "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                imageMode = "text_only",
            },
            token
        );
    }

    private static WebApplicationFactory<HealthController> Application(
        DeterministicServicesHandler handler,
        string setting,
        string value
    ) =>
        new WebApplicationFactory<HealthController>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration(
                (_, configuration) =>
                    configuration.AddInMemoryCollection(
                        new Dictionary<string, string?> { ["OpenRouter:ApiKey"] = "test-token", [setting] = value }
                    )
            );
            builder.ConfigureServices(services =>
            {
                services.AddHttpClient("browser").ConfigurePrimaryHttpMessageHandler(() => handler);
                services.AddHttpClient("openrouter").ConfigurePrimaryHttpMessageHandler(() => handler);
            });
        });
}
