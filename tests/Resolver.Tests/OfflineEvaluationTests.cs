using System.Diagnostics;
using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Xpathed.Resolver.Services;

namespace Xpathed.Resolver.Tests;

public sealed class OfflineEvaluationTests
{
    [Fact]
    public async Task PrepareOnlyBuildsTheRequestWithoutCredentialsOrBrowserClaims()
    {
        var (exitCode, output) = await RunAsync(
            """{"instruction":"Click Save","candidates":[{"id":"c1","tag":"button","label":"Save"}]}""",
            prepareOnly: true
        );
        Assert.Equal(0, exitCode);
        using var json = JsonDocument.Parse(output);
        var result = json.RootElement;
        Assert.Equal(4096, result.GetProperty("outputTokens").GetInt32());
        Assert.Contains("one interaction shared", result.GetProperty("prompt").GetString(), StringComparison.Ordinal);
        using var modelInput = JsonDocument.Parse(result.GetProperty("modelInput").GetString()!);
        Assert.Equal("c1", modelInput.RootElement.GetProperty("candidates")[0].GetProperty("id").GetString());
        Assert.False(modelInput.RootElement.GetProperty("candidates")[0].TryGetProperty("geometry", out _));
        Assert.False(modelInput.RootElement.GetProperty("candidates")[0].TryGetProperty("state", out _));
        Assert.DoesNotContain("synthetic-api-key", output, StringComparison.Ordinal);
        Assert.False(result.TryGetProperty("xpaths", out _));
    }

    [Fact]
    public async Task PreparedCandidatesStripCredentialTextAndUrlQueriesWhilePreservingUnicodeLabels()
    {
        var (_, output) = await RunAsync(
            """{"instruction":"Click Café","candidates":[{"id":"c1","tag":"button","label":"Café","text":"Bearer private-canary","scope":["https://example.test/path?ref=private-canary#private-canary"]}]}""",
            prepareOnly: true,
            endpoint: "http://127.0.0.1:1/api/v1/"
        );
        using var json = JsonDocument.Parse(output);
        var input = json.RootElement.GetProperty("modelInput").GetString()!;
        Assert.Contains("Café", input, StringComparison.Ordinal);
        Assert.DoesNotContain("private-canary", output, StringComparison.Ordinal);
        Assert.DoesNotContain("synthetic-api-key", output, StringComparison.Ordinal);
        using var parsed = JsonDocument.Parse(input);
        Assert.Equal("[redacted]", parsed.RootElement.GetProperty("candidates")[0].GetProperty("text").GetString());
        Assert.Equal(
            "https://example.test/path",
            parsed.RootElement.GetProperty("candidates")[0].GetProperty("scope")[0].GetString()
        );
    }

    [Theory]
    [InlineData("valid", null)]
    [InlineData("plural", null)]
    [InlineData("unknown", "provider_unknown_candidate")]
    [InlineData("mixed", "provider_malformed_response")]
    [InlineData("duplicate", "provider_malformed_response")]
    [InlineData("malformed", "provider_malformed_response")]
    [InlineData("incomplete", "decomposition_incomplete")]
    [InlineData("truncated", "provider_truncated_response")]
    [InlineData("rate_limited", "provider_rate_limited")]
    [InlineData("missing_usage", null)]
    public async Task OfflineInferenceReusesSelectionValidationAndReportsOneSharedChargeWithoutBrowserClaims(
        string scenario,
        string? expectedCode
    )
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        await using var provider = builder.Build();
        var calls = 0;
        string? sentPrompt = null;
        provider.MapPost(
            "/api/v1/chat/completions",
            async context =>
            {
                calls++;
                using var request = await JsonDocument.ParseAsync(context.Request.Body);
                Assert.Equal("configured/model", request.RootElement.GetProperty("model").GetString());
                sentPrompt = request.RootElement.GetProperty("messages")[0].GetProperty("content").GetString();
                const string valid =
                    """{"complete":true,"actions":[{"step":1,"instruction":"Click Save","outcome":"found","action":"click","candidateId":"c1","limitation":"none"}]}""";
                var content = scenario switch
                {
                    "plural" => valid.Replace(
                        "]}",
                        """,{"step":2,"instruction":"Click Cancel","outcome":"found","action":"click","candidateId":"c2","limitation":"none"}]}""",
                        StringComparison.Ordinal
                    ),
                    "unknown" => valid.Replace("c1", "unknown", StringComparison.Ordinal),
                    "malformed" => "{bad",
                    "incomplete" => """{"complete":false,"actions":[]}""",
                    "mixed" => valid.Replace(
                        "]}",
                        """,{"step":2,"instruction":"Hover missing","outcome":"not_found","action":"hover","candidateId":null,"limitation":"none"}]}""",
                        StringComparison.Ordinal
                    ),
                    "duplicate" => valid.Replace(
                        "]}",
                        """,{"step":2,"instruction":"Click Save again","outcome":"found","action":"click","candidateId":"c1","limitation":"none"}]}""",
                        StringComparison.Ordinal
                    ),
                    _ => valid,
                };
                context.Response.StatusCode = scenario == "rate_limited" ? 429 : 200;
                await context.Response.WriteAsJsonAsync(
                    new
                    {
                        id = "generation-offline",
                        model = "configured/model",
                        provider = "configured-route",
                        choices = new[]
                        {
                            new
                            {
                                finish_reason = scenario == "truncated" ? "length" : "stop",
                                message = new { content },
                            },
                        },
                        usage = scenario == "missing_usage"
                            ? null
                            : new
                            {
                                prompt_tokens = 100,
                                completion_tokens = 40,
                                cost = 0.0001m,
                            },
                    }
                );
            }
        );
        await provider.StartAsync();
        var input =
            scenario == "plural"
                ? """{"instruction":"Click Save and Cancel","candidates":[{"id":"c1","tag":"button","label":"Save"},{"id":"c2","tag":"button","label":"Cancel"}]}"""
                : """{"instruction":"Click Save","candidates":[{"id":"c1","tag":"button","label":"Save"}]}""";
        var (_, preparedOutput) = await RunAsync(
            input,
            prepareOnly: true,
            endpoint: provider.Urls.Single() + "/api/v1/"
        );
        using var prepared = JsonDocument.Parse(preparedOutput);
        var (exitCode, output) = await RunAsync(
            input,
            prepareOnly: false,
            endpoint: provider.Urls.Single() + "/api/v1/"
        );
        Assert.Equal(prepared.RootElement.GetProperty("prompt").GetString(), sentPrompt);
        Assert.Equal(expectedCode is null ? 0 : 1, exitCode);
        using var json = JsonDocument.Parse(output);
        var result = json.RootElement;
        Assert.Equal(
            prepared.RootElement.GetProperty("configurationId").GetString(),
            result.GetProperty("configurationId").GetString()
        );
        Assert.Equal(expectedCode is null ? "found" : "error", result.GetProperty("outcome").GetString());
        if (expectedCode is null)
        {
            Assert.Equal("click", result.GetProperty("action").GetString());
            Assert.Equal("c1", result.GetProperty("actions")[0].GetProperty("candidateId").GetString());
            Assert.Equal(scenario == "plural" ? 2 : 1, result.GetProperty("actions").GetArrayLength());
            if (scenario == "plural")
            {
                Assert.Equal("c2", result.GetProperty("actions")[1].GetProperty("candidateId").GetString());
            }
        }
        else
        {
            Assert.Empty(result.GetProperty("actions").EnumerateArray());
            Assert.Equal(expectedCode, result.GetProperty("diagnostics").GetProperty("code").GetString());
        }
        if (scenario == "missing_usage")
        {
            Assert.Equal(JsonValueKind.Null, result.GetProperty("diagnostics").GetProperty("usage").ValueKind);
        }
        else
        {
            Assert.Equal(
                0.0001m,
                result.GetProperty("diagnostics").GetProperty("usage").GetProperty("cost").GetDecimal()
            );
        }
        Assert.True(result.GetProperty("providerLatencyMs").GetDouble() >= 0);
        Assert.Equal(1, result.GetProperty("diagnostics").GetProperty("modelCalls").GetInt32());
        Assert.Equal(1, calls);
        Assert.False(result.TryGetProperty("xpaths", out _));
        Assert.DoesNotContain("synthetic-api-key", output, StringComparison.Ordinal);
        await provider.StopAsync();
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("[]")]
    [InlineData("null")]
    [InlineData("{bad")]
    [InlineData("{\"instruction\":\"Click Save\",\"candidates\":[],\"html\":\"private\"}")]
    [InlineData("{\"instruction\":\"Click Save\",\"instruction\":\"Hover\",\"candidates\":[]}")]
    [InlineData("{\"instruction\":\"Click Save\",\"candidates\":[{\"id\":\"c1\",\"tag\":\"button\",\"state\":{}}]}")]
    [InlineData(
        "{\"instruction\":\"Click Save\",\"candidates\":[{\"id\":\"c1\",\"tag\":\"button\",\"value\":\"private\"}]}"
    )]
    [InlineData(
        "{\"instruction\":\"Click Save\",\"candidates\":[{\"id\":\"c1\",\"tag\":\"button\"},{\"id\":\"c1\",\"tag\":\"button\"}]}"
    )]
    public async Task MalformedOrUnreviewedFieldsAreRejectedBeforeProviderCalls(string input)
    {
        var (exitCode, output) = await RunAsync(input, prepareOnly: true);
        Assert.Equal(1, exitCode);
        using var json = JsonDocument.Parse(output);
        Assert.Equal(
            "invalid_offline_input",
            json.RootElement.GetProperty("diagnostics").GetProperty("code").GetString()
        );
        Assert.Equal(0, json.RootElement.GetProperty("diagnostics").GetProperty("modelCalls").GetInt32());
        Assert.DoesNotContain("private", output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task OversizedInputIsRejectedBeforeProviderCalls()
    {
        var (exitCode, output) = await RunAsync(new string('x', 512001), prepareOnly: true);
        Assert.Equal(1, exitCode);
        using var json = JsonDocument.Parse(output);
        Assert.Equal(
            "model_input_budget_exceeded",
            json.RootElement.GetProperty("diagnostics").GetProperty("code").GetString()
        );
        Assert.Equal(0, json.RootElement.GetProperty("diagnostics").GetProperty("modelCalls").GetInt32());
    }

    [Fact]
    public async Task LiveOfflineCommandRequiresCredentialsWithoutStartingAService()
    {
        var (exitCode, output) = await RunAsync("""{"instruction":"Click Save","candidates":[]}""", prepareOnly: false);
        Assert.Equal(1, exitCode);
        using var json = JsonDocument.Parse(output);
        Assert.Equal(
            "provider_not_configured",
            json.RootElement.GetProperty("diagnostics").GetProperty("code").GetString()
        );
        Assert.Equal(0, json.RootElement.GetProperty("diagnostics").GetProperty("modelCalls").GetInt32());
    }

    private static async Task<(int ExitCode, string Output)> RunAsync(
        string input,
        bool prepareOnly,
        string? endpoint = null
    )
    {
        var path = Path.Combine(Path.GetTempPath(), $"xpathed-offline-{Guid.NewGuid():N}.json");
        await File.WriteAllTextAsync(path, input);
        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo("dotnet")
                {
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                },
            };
            process.StartInfo.ArgumentList.Add(typeof(OpenRouterGateway).Assembly.Location);
            process.StartInfo.ArgumentList.Add("--evaluate-offline");
            process.StartInfo.ArgumentList.Add(path);
            if (prepareOnly)
            {
                process.StartInfo.ArgumentList.Add("--prepare-only");
            }
            process.StartInfo.Environment["OpenRouter__ApiKey"] = endpoint is null ? "" : "synthetic-api-key";
            process.StartInfo.Environment["OpenRouter__Model"] = "configured/model";
            process.StartInfo.Environment["OpenRouter__Provider"] = "configured-route";
            if (endpoint is not null)
            {
                process.StartInfo.Environment["OpenRouter__BaseUrl"] = endpoint;
            }
            Assert.True(process.Start());
            var output = process.StandardOutput.ReadToEndAsync();
            var errors = process.StandardError.ReadToEndAsync();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            try
            {
                await process.WaitForExitAsync(deadline.Token);
            }
            catch (OperationCanceledException)
            {
                process.Kill(entireProcessTree: true);
                throw new InvalidOperationException("Offline command did not exit: " + await errors);
            }
            return (process.ExitCode, await output);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
