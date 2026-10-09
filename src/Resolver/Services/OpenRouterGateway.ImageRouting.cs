using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Threading.RateLimiting;
using Xpathed.Common.Contracts;

namespace Xpathed.Resolver.Services;

public sealed partial class OpenRouterGateway
{
    internal const string ImageRoutingModel = "typesafe/jev-1.13";
    internal const string ImageRoutingProvider = "TypeSafe";
    internal const int ImageRoutingTimeoutMilliseconds = 1000;
    private static readonly string[] ImageRoutingProviders = ["typesafe"];

    internal Task<ProviderCompletion> DecideImageAsync(
        string state,
        CancellationToken cancellationToken,
        Action<ResolutionDiagnostics>? observeUsage = null
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        return DecideImageCoreAsync(state, observeUsage, usageLimits.Acquire(), cancellationToken);
    }

    private async Task<ProviderCompletion> DecideImageCoreAsync(
        string state,
        Action<ResolutionDiagnostics>? observeUsage,
        RateLimitLease lease,
        CancellationToken cancellationToken
    )
    {
        using var reservation = lease;
        using var client = clients.CreateClient("openrouter");
        client.BaseAddress = new Uri(endpoint);
        client.Timeout = TimeSpan.FromMilliseconds(ImageRoutingTimeoutMilliseconds);
        using var request = new HttpRequestMessage(HttpMethod.Post, "../alpha/decisions");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        request.Headers.Add("X-OpenRouter-Cache", "false");
        request.Headers.Add("X-OpenRouter-Metadata", "enabled");
        request.Content = JsonContent.Create(
            new
            {
                model = ImageRoutingModel,
                provider = new { only = ImageRoutingProviders, allow_fallbacks = false },
                state = JsonSerializer.Deserialize<JsonElement>(state),
                questions = ImageRoutingPolicy.Questions,
            }
        );
        var timer = Stopwatch.StartNew();
        using var response = await client.SendAsync(request, cancellationToken);
        JsonElement body;
        try
        {
            body = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken);
        }
        catch (JsonException)
        {
            return new ProviderCompletion(
                null,
                new ResolutionDiagnostics
                {
                    Code = response.IsSuccessStatusCode
                        ? "provider_malformed_response"
                        : ErrorCode((int)response.StatusCode, default),
                    TimingsMs = new Dictionary<string, double> { ["provider"] = timer.Elapsed.TotalMilliseconds },
                }
            );
        }
        var usage = Property(body, "usage");
        var inputTokens = ReadCount(usage, "input_tokens");
        var outputTokens = ReadCount(usage, "output_tokens");
        var diagnostics = new ResolutionDiagnostics
        {
            Model = ReadString(body, "model"),
            Provider = ReadString(body, "provider"),
            GenerationId = ReadString(body, "id"),
            TimingsMs = new Dictionary<string, double> { ["provider"] = timer.Elapsed.TotalMilliseconds },
            Usage =
                usage.ValueKind == JsonValueKind.Object
                    ? new ModelUsage(
                        inputTokens,
                        outputTokens,
                        inputTokens is { } input && outputTokens is { } output && input <= long.MaxValue - output
                            ? input + output
                            : null,
                        null,
                        null,
                        Property(usage, "cost") is { ValueKind: JsonValueKind.Number } cost
                        && cost.TryGetDecimal(out var amount)
                        && amount >= 0
                            ? amount
                            : null
                    )
                    : null,
        };
        observeUsage?.Invoke(diagnostics);
        var error = Property(body, "error");
        var answers = Property(body, "answers");
        var code =
            !response.IsSuccessStatusCode || error.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null)
                ? ErrorCode((int)response.StatusCode, error)
            : Property(body, "provider").ValueKind is not (JsonValueKind.Undefined or JsonValueKind.String)
            || Property(body, "id").ValueKind is not (JsonValueKind.Undefined or JsonValueKind.String)
            || Property(usage, "cost").ValueKind != JsonValueKind.Undefined && diagnostics.Usage?.Cost is null
                ? "provider_malformed_response"
            : string.IsNullOrWhiteSpace(diagnostics.Model) ? "provider_malformed_response"
            : diagnostics.Model is not (ImageRoutingModel or "typesafe/jev-1.13-20260917")
            || diagnostics.Provider is not null
                && !string.Equals(diagnostics.Provider, ImageRoutingProvider, StringComparison.Ordinal)
                ? "provider_identity_mismatch"
            : inputTokens is null
            || outputTokens is null
            || diagnostics.Usage?.TotalTokens is null
            || !ImageRoutingPolicy.TryReadProbabilities(answers, out _, out _)
                ? "provider_malformed_response"
            : null;
        return new ProviderCompletion(
            code is null ? answers.GetRawText() : null,
            diagnostics with
            {
                Code = code,
                CostEstimate =
                    code == "provider_identity_mismatch"
                        ? null
                        : EstimateCost(diagnostics, cancellationToken, ImageRoutingModel),
            }
        );
    }
}
