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

public sealed class ProviderRequestTests
{
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
}
