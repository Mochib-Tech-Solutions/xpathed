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

public sealed class ProviderFailuresTests
{
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
}
