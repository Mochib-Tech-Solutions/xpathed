using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xpathed.ClientApi.Controllers;

namespace Xpathed.ClientApi.Tests;

public sealed class ControllerContractTests
{
    [Fact]
    public async Task HealthReportsServiceAndContractWithoutStorage()
    {
        await using var application = new WebApplicationFactory<HealthController>();
        using var client = application.CreateClient();
        using var response = await client.GetAsync("/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("client-api", body.GetProperty("service").GetString());
        Assert.Equal(["service"], body.EnumerateObject().Select(item => item.Name).Order());
        using var removed = await client.GetAsync("/internal/diagnostics");
        Assert.Equal(HttpStatusCode.NotFound, removed.StatusCode);
    }

    [Theory]
    [InlineData(HttpStatusCode.OK, "{\"outcome\":\"found\",\"attemptId\":\"attempt-1\"}")]
    [InlineData(HttpStatusCode.BadRequest, "{\"code\":\"invalid_request\"}")]
    [InlineData(HttpStatusCode.BadGateway, "{\"code\":\"provider_unavailable\"}")]
    public async Task ResolutionForwardsTheRequestAndOriginalResponse(HttpStatusCode status, string result)
    {
        const string body = "{\"instruction\":\"click Save\",\"documentId\":\"doc-1\"}";
        using var upstream = new ResolverHandler(status, result);
        await using var application = Application(upstream);
        using var client = application.CreateClient();
        using var content = new StringContent(body, Encoding.UTF8, "application/json");
        using var response = await client.PostAsync("/api/pages/page-1/resolve", content);

        Assert.Equal(HttpMethod.Post, upstream.Method);
        Assert.Equal("/pages/page-1/resolve", upstream.Path);
        Assert.Equal(body, upstream.Body);
        Assert.Equal("application/json", upstream.ContentType);
        Assert.Equal(status, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal(result, await response.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData(HttpStatusCode.OK, "{\"actionId\":\"a1\",\"status\":\"completed\"}")]
    [InlineData(HttpStatusCode.Conflict, "{\"code\":\"stale_capture\"}")]
    public async Task ExecutionForwardsDirectlyToBrowser(HttpStatusCode status, string result)
    {
        const string body =
            "{\"sessionId\":\"session\",\"documentId\":\"doc\",\"captureId\":\"capture\",\"actionId\":\"a1\",\"value\":\"test-value\"}";
        using var upstream = new ResolverHandler(status, result);
        await using var app = Application(upstream, "browser");
        using var client = app.CreateClient();
        using var content = new StringContent(body, Encoding.UTF8, "application/json");
        using var response = await client.PostAsync("/api/pages/page-1/execute", content);
        Assert.Equal("/pages/page-1/execute", upstream.Path);
        Assert.Equal(HttpMethod.Post, upstream.Method);
        Assert.Equal(body, upstream.Body);
        Assert.Equal(status, response.StatusCode);
        Assert.Equal(result, await response.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("GET", "/api/sessions/options", "/sessions/options", null, HttpStatusCode.OK)]
    [InlineData("POST", "/api/sessions", "/sessions", "{\"browserType\":\"chromium\"}", HttpStatusCode.OK)]
    [InlineData("POST", "/api/sessions", "/sessions", "{\"browserType\":\"webkit\"}", HttpStatusCode.BadRequest)]
    public async Task BrowserOptionsAndEngineSelectionAreForwarded(
        string method,
        string path,
        string forwardedPath,
        string? body,
        HttpStatusCode status
    )
    {
        const string result = "{\"browserType\":\"chromium\"}";
        using var upstream = new ResolverHandler(status, result);
        await using var app = Application(upstream, "browser");
        using var client = app.CreateClient();
        using var request = new HttpRequestMessage(new HttpMethod(method), path);
        if (body is not null)
        {
            request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        }
        using var response = await client.SendAsync(request);
        Assert.Equal(forwardedPath, upstream.Path);
        Assert.Equal(new HttpMethod(method), upstream.Method);
        if (body is not null)
        {
            Assert.Equal(body, upstream.Body);
        }
        Assert.Equal(status, response.StatusCode);
        Assert.Equal(result, await response.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("")]
    [InlineData("{\"browserType\":\"chromium\"}")]
    public async Task SessionRequestsPreserveContentLengthBeforeStreaming(string body)
    {
        using var upstream = new ResolverHandler(HttpStatusCode.OK, "{}");
        await using var app = Application(upstream, "browser");
        using var client = app.CreateClient();
        using var content = new StringContent(body, Encoding.UTF8, "application/json");
        using var response = await client.PostAsync("/api/sessions", content);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(Encoding.UTF8.GetByteCount(body), upstream.ContentLength);
        Assert.Equal(body, upstream.Body);
        Assert.Equal("application/json", upstream.ContentType);
    }

    [Fact]
    public async Task ForeignOriginIsRejectedBeforeForwarding()
    {
        using var upstream = new ResolverHandler(HttpStatusCode.OK, "{}");
        await using var application = Application(upstream);
        using var client = application.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/pages/page-1/resolve");
        request.Headers.Add("Origin", "https://unrelated.example");
        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Null(upstream.Path);
    }

    [Fact]
    public async Task UpstreamRateLimitPreservesBodyStatusAndRetryAfter()
    {
        using var upstream = new ResolverHandler(
            HttpStatusCode.TooManyRequests,
            "{\"code\":\"request_rate_limited\",\"message\":\"Try later\"}"
        )
        {
            RetryAfter = TimeSpan.FromSeconds(37),
        };
        await using var app = Application(upstream);
        using var client = app.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/api/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        Assert.Equal(HttpStatusCode.TooManyRequests, response.StatusCode);
        Assert.Equal(TimeSpan.FromSeconds(37), response.Headers.RetryAfter?.Delta);
        Assert.Equal(
            "Try later",
            (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("message").GetString()
        );
    }

    [Fact]
    public async Task SharedRateLimitCannotBeBypassedWithDifferentPageOrForwardedAddress()
    {
        using var upstream = new ResolverHandler(HttpStatusCode.OK, "{}");
        await using var app = LimitedApplication(upstream, "RateLimits:RequestsPerMinute", "1");
        using var client = app.CreateClient();
        using var first = await client.PostAsJsonAsync(
            "/api/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        client.DefaultRequestHeaders.Add("X-Forwarded-For", "198.51.100.8");
        using var rejected = await client.PostAsJsonAsync(
            "/api/pages/different-page/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        Assert.Equal(HttpStatusCode.TooManyRequests, rejected.StatusCode);
        Assert.True(rejected.Headers.RetryAfter?.Delta > TimeSpan.Zero);
        Assert.Equal(
            "request_rate_limited",
            (await rejected.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString()
        );
        Assert.Equal(1, upstream.RequestCount);
        using var health = await client.GetAsync("/health");
        Assert.Equal(HttpStatusCode.OK, health.StatusCode);
    }

    [Fact]
    public async Task ConcurrentRequestLimitRejectsWithoutQueuingAndReleasesAfterCompletion()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var upstream = new ResolverHandler(HttpStatusCode.OK, "{}")
        {
            BeforeRespondAsync = async token =>
            {
                started.TrySetResult();
                await finish.Task.WaitAsync(token);
            },
        };
        await using var app = LimitedApplication(upstream, "RateLimits:ConcurrentRequests", "1");
        using var client = app.CreateClient();
        var pending = client.PostAsJsonAsync(
            "/api/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        try
        {
            await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            using var rejected = await client
                .PostAsJsonAsync(
                    "/api/pages/page-2/resolve",
                    new { instruction = "Click Save", documentId = "document-1" }
                )
                .WaitAsync(TimeSpan.FromSeconds(2));
            Assert.Equal(HttpStatusCode.TooManyRequests, rejected.StatusCode);
            Assert.Equal(1, upstream.RequestCount);
        }
        finally
        {
            finish.TrySetResult();
        }
        using var completed = await pending;
        Assert.Equal(HttpStatusCode.OK, completed.StatusCode);
        using var next = await client.PostAsJsonAsync(
            "/api/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        Assert.Equal(HttpStatusCode.OK, next.StatusCode);
        Assert.Equal(2, upstream.RequestCount);
    }

    private static WebApplicationFactory<HealthController> LimitedApplication(
        ResolverHandler upstream,
        string setting,
        string value
    ) =>
        Application(upstream)
            .WithWebHostBuilder(builder =>
                builder.ConfigureAppConfiguration(
                    (_, configuration) =>
                        configuration.AddInMemoryCollection(new Dictionary<string, string?> { [setting] = value })
                )
            );

    private static WebApplicationFactory<HealthController> Application(
        ResolverHandler upstream,
        string target = "resolver"
    ) =>
        new WebApplicationFactory<HealthController>().WithWebHostBuilder(builder =>
            builder.ConfigureTestServices(services =>
                services.AddHttpClient(target).ConfigurePrimaryHttpMessageHandler(() => upstream)
            )
        );
}
