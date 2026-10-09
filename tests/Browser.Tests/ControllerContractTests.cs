using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
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
    [InlineData("webkit")]
    [InlineData("")]
    [InlineData("Firefox")]
    [InlineData("/usr/bin/firefox")]
    public async Task InvalidEngineIsRejectedBeforeStartingADisplay(string browserType)
    {
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/sessions", new { browserType });
        await AssertErrorAsync(response, HttpStatusCode.BadRequest, "invalid_browser_type");
    }

    [Theory]
    [InlineData("")]
    [InlineData("1x1")]
    [InlineData("999999x999999")]
    public async Task InvalidResolutionIsRejectedBeforeStartingADisplay(string resolution)
    {
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync("/sessions", new { resolution });
        await AssertErrorAsync(response, HttpStatusCode.BadRequest, "invalid_resolution");
    }

    [Theory]
    [InlineData("chromium")]
    [InlineData("firefox")]
    public async Task SessionOptionsExposeConfiguredDefaultAndInstalledEngines(string defaultType)
    {
        using var configured = application.WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration(
                (_, config) =>
                    config.AddInMemoryCollection(
                        new Dictionary<string, string?> { ["DefaultBrowserType"] = defaultType }
                    )
            )
        );
        using var client = configured.CreateClient();
        using var response = await client.GetAsync("/sessions/options");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(defaultType, body.GetProperty("defaultBrowserType").GetString());
        Assert.Equal("1280x800", body.GetProperty("defaultResolution").GetString());
        Assert.Contains(
            body.GetProperty("resolutions").EnumerateArray(),
            choice =>
                choice.GetProperty("id").GetString() == "1920x1080"
                && choice.GetProperty("width").GetInt32() == 1920
                && choice.GetProperty("height").GetInt32() == 1080
        );
        Assert.Equal(
            ["chromium", "firefox"],
            body.GetProperty("browserTypes").EnumerateArray().Select(type => type.GetString())
        );
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
    [InlineData("GET", "/sessions/missing", "session_not_found")]
    [InlineData("POST", "/sessions/missing/pages", "session_not_found")]
    [InlineData("POST", "/pages/missing/activate", "page_not_found")]
    [InlineData("DELETE", "/pages/missing", "page_not_found")]
    public async Task UnknownSessionOrTabOperationReturnsAnError(string method, string path, string code)
    {
        using var client = application.CreateClient();
        using var request = new HttpRequestMessage(new HttpMethod(method), path);
        using var response = await client.SendAsync(request);

        await AssertErrorAsync(response, HttpStatusCode.NotFound, code);
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
    [InlineData("{}")]
    [InlineData("{\"documentId\":\"doc\",\"captureId\":null,\"actionId\":\"a1\"}")]
    [InlineData("{\"documentId\":\"doc\",\"captureId\":\"capture\",\"actionId\":\"\"}")]
    public async Task InvalidSpotlightIdentityIsRejectedBeforePageLookup(string body)
    {
        using var client = application.CreateClient();
        using var content = new StringContent(body, Encoding.UTF8, "application/json");
        using var response = await client.PostAsync("/pages/missing/spotlight", content);
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
    [InlineData("capture", "{}")]
    [InlineData("capture", "{\"documentId\":null}")]
    [InlineData("capture", "{\"documentId\":\"document\",\"scope\":\"visible\"}")]
    [InlineData("capture", "{\"documentId\":\"document\",\"scope\":null}")]
    [InlineData("selection", "{}")]
    [InlineData("selection", "{\"documentId\":\"document\",\"captureId\":\"capture\"}")]
    [InlineData("selections", "{\"documentId\":\"document\",\"captureId\":\"capture\",\"actions\":[null]}")]
    [InlineData("selections", "{\"documentId\":\"document\",\"captureId\":\"capture\",\"actions\":[]}")]
    [InlineData("highlight", "{}")]
    [InlineData("execute", "{}")]
    [InlineData(
        "execute",
        "{\"sessionId\":\"session\",\"documentId\":\"doc\",\"captureId\":\"capture\",\"actionId\":\"\"}"
    )]
    public async Task InvalidResolutionBodyReturnsBadRequest(string operation, string body)
    {
        using var client = application.CreateClient();
        using var content = new StringContent(body, Encoding.UTF8, "application/json");
        using var response = await client.PostAsync($"/pages/missing/{operation}", content);

        await AssertErrorAsync(response, HttpStatusCode.BadRequest, "invalid_request");
    }

    [Fact]
    public async Task UnsupportedActionIsRejectedBeforePageLookup()
    {
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/missing/selection",
            new
            {
                documentId = "document",
                captureId = "capture",
                candidateId = "candidate",
                action = "execute",
            }
        );

        await AssertErrorAsync(response, HttpStatusCode.BadRequest, "invalid_action");
    }

    [Fact]
    public async Task UnknownExecutionPageDoesNotStartAnOperation()
    {
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/missing/execute",
            new
            {
                sessionId = "session",
                documentId = "document",
                captureId = "capture",
                actionId = "a1",
            }
        );
        await AssertErrorAsync(response, HttpStatusCode.NotFound, "page_not_found");
    }

    [Fact]
    public async Task OversizedExecutionValueIsRejectedBeforePageLookup()
    {
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/missing/execute",
            new
            {
                sessionId = "session",
                documentId = "document",
                captureId = "capture",
                actionId = "a1",
                value = new string('x', 10001),
            }
        );
        await AssertErrorAsync(response, HttpStatusCode.BadRequest, "invalid_request");
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
