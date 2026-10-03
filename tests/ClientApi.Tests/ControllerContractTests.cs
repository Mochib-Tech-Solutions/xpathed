using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
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
        Assert.Equal("4", body.GetProperty("resolutionContract").GetString());
        Assert.Equal(["resolutionContract", "service"], body.EnumerateObject().Select(item => item.Name).Order());
        using var removed = await client.GetAsync("/internal/diagnostics");
        Assert.Equal(HttpStatusCode.NotFound, removed.StatusCode);
    }

    [Theory]
    [InlineData(HttpStatusCode.OK, "{\"outcome\":\"found\",\"attemptId\":\"attempt-1\"}")]
    [InlineData(HttpStatusCode.BadRequest, "{\"code\":\"invalid_request\"}")]
    [InlineData(HttpStatusCode.BadGateway, "{\"code\":\"provider_unavailable\"}")]
    public async Task ResolutionForwardsTheRequestAndOriginalResponse(HttpStatusCode status, string result)
    {
        const string body = "{\"instruction\":\"click Save\",\"documentId\":\"doc-1\",\"contractVersion\":\"4\"}";
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

    private static WebApplicationFactory<HealthController> Application(ResolverHandler upstream) =>
        new WebApplicationFactory<HealthController>().WithWebHostBuilder(builder =>
            builder.ConfigureTestServices(services =>
                services.AddHttpClient("resolver").ConfigurePrimaryHttpMessageHandler(() => upstream)
            )
        );
}
