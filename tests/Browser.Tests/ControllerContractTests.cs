using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Xpathed.Browser.Controllers;

namespace Xpathed.Browser.Tests;

public sealed class ControllerContractTests(WebApplicationFactory<HealthController> application)
    : IClassFixture<WebApplicationFactory<HealthController>>
{
    [Fact]
    public async Task HealthReportsBrowserService()
    {
        using var client = application.CreateClient();
        using var response = await client.GetAsync("/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("browser", body.GetProperty("service").GetString());
    }

    [Theory]
    [InlineData("/pages/missing")]
    [InlineData("/pages/missing/inspection")]
    public async Task UnknownManagedPageReturnsNotFound(string path)
    {
        using var client = application.CreateClient();
        using var response = await client.GetAsync(path);

        await AssertErrorAsync(response, HttpStatusCode.NotFound, "page_not_found");
    }

    [Theory]
    [InlineData("")]
    [InlineData("{")]
    [InlineData("{}")]
    [InlineData("{\"url\":null}")]
    public async Task InvalidNavigationBodyReturnsBadRequest(string body)
    {
        using var client = application.CreateClient();
        using var content = new StringContent(body, Encoding.UTF8, "application/json");
        using var response = await client.PostAsync("/pages/missing/navigate", content);

        await AssertErrorAsync(response, HttpStatusCode.BadRequest, "invalid_request");
    }

    [Theory]
    [InlineData("file:///etc/passwd")]
    [InlineData("https://name:secret@example.com")]
    public async Task InvalidNavigationUrlIsRejectedBeforePageLookup(string url)
    {
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/pages/missing/navigate", new { url });

        await AssertErrorAsync(response, HttpStatusCode.BadRequest, "invalid_url");
    }

    [Theory]
    [InlineData("POST", "/sessions")]
    [InlineData("DELETE", "/sessions/missing")]
    [InlineData("GET", "/pages/missing")]
    public async Task BrowserOriginCannotControlSessionsOrPages(string method, string path)
    {
        using var client = application.CreateClient();
        using var request = new HttpRequestMessage(new HttpMethod(method), path);
        request.Headers.Add("Origin", "https://unrelated.example");
        using var response = await client.SendAsync(request);

        await AssertErrorAsync(response, HttpStatusCode.Forbidden, "invalid_origin");
    }

    [Theory]
    [InlineData(null, HttpStatusCode.Forbidden, "invalid_origin")]
    [InlineData("https://unrelated.example", HttpStatusCode.Forbidden, "invalid_origin")]
    [InlineData("http://localhost:8080", HttpStatusCode.BadRequest, "websocket_required")]
    public async Task ViewerRejectsInvalidOriginOrMissingWebSocket(string? origin, HttpStatusCode status, string code)
    {
        using var client = application.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/view/missing");
        if (origin is not null)
        {
            request.Headers.Add("Origin", origin);
        }
        using var response = await client.SendAsync(request);

        await AssertErrorAsync(response, status, code);
    }

    [Fact]
    public async Task DeletingAnUnknownSessionIsIdempotent()
    {
        using var client = application.CreateClient();
        for (var attempt = 0; attempt < 2; attempt++)
        {
            using var response = await client.DeleteAsync("/sessions/missing");

            Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
            Assert.Empty(await response.Content.ReadAsStringAsync());
        }
    }

    private static async Task AssertErrorAsync(HttpResponseMessage response, HttpStatusCode status, string code)
    {
        Assert.Equal(status, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(["code", "message", "traceId"], body.EnumerateObject().Select(property => property.Name).Order());
        Assert.Equal(code, body.GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(body.GetProperty("message").GetString()));
        Assert.False(string.IsNullOrWhiteSpace(body.GetProperty("traceId").GetString()));
    }
}
