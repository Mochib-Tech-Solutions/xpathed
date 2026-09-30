using System.Diagnostics;
using System.Globalization;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Resolver.Services;

public sealed class OpenRouterGateway(IHttpClientFactory clients, IConfiguration configuration)
{
    public string Model { get; } = configuration["OpenRouter:Model"] ?? "deepseek/deepseek-v4.1-flash";
    public string Provider { get; } = configuration["OpenRouter:Provider"] ?? "wafer";

    internal Dictionary<string, decimal>? EvaluationPriceLimits { get; set; }

    private readonly string? apiKey = configuration["OpenRouter:ApiKey"];
    private readonly string endpoint =
        (configuration["OpenRouter:BaseUrl"] ?? "https://openrouter.ai/api/v1/").TrimEnd('/') + "/";
    private readonly double timeoutSeconds = double.TryParse(
        configuration["OpenRouter:TimeoutSeconds"] ?? "30",
        NumberStyles.Float,
        CultureInfo.InvariantCulture,
        out var value
    )
        ? value
        : 0;

    internal void EnsureConfigured()
    {
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            throw new ApiException(
                503,
                "provider_not_configured",
                "Configure the OpenRouter API key to resolve instructions."
            );
        }
        if (
            !Uri.TryCreate(endpoint, UriKind.Absolute, out var address)
            || address.Scheme is not ("https" or "http")
            || !string.IsNullOrEmpty(address.UserInfo)
            || !string.IsNullOrEmpty(address.Query)
            || !string.IsNullOrEmpty(address.Fragment)
            || !double.IsFinite(timeoutSeconds)
            || timeoutSeconds <= 0
            || timeoutSeconds > 600
            || string.IsNullOrWhiteSpace(Model)
            || string.IsNullOrWhiteSpace(Provider)
        )
        {
            throw new ApiException(
                503,
                "invalid_provider_configuration",
                "Configure an HTTP endpoint, model, provider and timeout between zero and 600 seconds."
            );
        }
    }

    internal string ConfigurationId(
        string strategy,
        string prompt,
        JsonElement schema,
        int modelInputBudgetBytes,
        int outputTokens,
        string promptVersion,
        int maximumActions
    ) =>
        Convert.ToHexStringLower(
            SHA256.HashData(
                Encoding.UTF8.GetBytes(
                    JsonSerializer.Serialize(
                        DescribeConfiguration(
                            strategy,
                            prompt,
                            schema,
                            modelInputBudgetBytes,
                            outputTokens,
                            promptVersion,
                            maximumActions
                        )
                    )
                )
            )
        );

    internal object DescribeConfiguration(
        string strategy,
        string prompt,
        JsonElement schema,
        int modelInputBudgetBytes,
        int outputTokens,
        string promptVersion,
        int maximumActions
    ) =>
        new
        {
            strategy,
            promptVersion,
            captureVersion = "4",
            stateVersion = "2",
            interactabilityVersion = "2",
            xpathVersion = "3",
            endpoint = Uri.TryCreate(endpoint, UriKind.Absolute, out var address) ? address.AbsoluteUri : endpoint,
            timeoutSeconds = timeoutSeconds.ToString("R", CultureInfo.InvariantCulture),
            modelInputBudgetBytes,
            responseCache = false,
            maximumActions,
            request = CreateRequest(prompt, string.Empty, schema, outputTokens),
        };

    private object CreateRequest(string prompt, string input, JsonElement schema, int outputTokens) =>
        new
        {
            model = Model,
            stream = false,
            max_tokens = outputTokens,
            reasoning = new { enabled = false },
            provider = ProviderSettings(),
            plugins = new[] { new { id = "context-compression", enabled = false } },
            messages = new[] { new { role = "system", content = prompt }, new { role = "user", content = input } },
            response_format = new
            {
                type = "json_schema",
                json_schema = new
                {
                    name = "target_selection",
                    strict = true,
                    schema,
                },
            },
        };

    private Dictionary<string, object> ProviderSettings()
    {
        var settings = new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["only"] = new[] { Provider },
            ["order"] = new[] { Provider },
            ["allow_fallbacks"] = false,
            ["require_parameters"] = true,
        };
        if (EvaluationPriceLimits is not null)
        {
            settings["max_price"] = EvaluationPriceLimits;
        }
        return settings;
    }

    internal async Task<ProviderCompletion> CompleteAsync(
        string prompt,
        string input,
        JsonElement schema,
        CancellationToken cancellationToken,
        int outputTokens = 512
    )
    {
        using var client = clients.CreateClient("openrouter");
        client.BaseAddress = new Uri(endpoint);
        client.Timeout = TimeSpan.FromSeconds(timeoutSeconds);
        using var request = new HttpRequestMessage(HttpMethod.Post, "chat/completions");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        request.Headers.Add("X-OpenRouter-Cache", "false");
        request.Headers.Add("X-OpenRouter-Metadata", "enabled");
        request.Content = JsonContent.Create(CreateRequest(prompt, input, schema, outputTokens));
        var providerTimer = Stopwatch.StartNew();
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
                }
            );
        }
        var choices = Property(body, "choices");
        var choice = choices.ValueKind == JsonValueKind.Array && choices.GetArrayLength() == 1 ? choices[0] : default;
        var message = Property(choice, "message");
        var finishReason = ReadString(choice, "finish_reason");
        var usage = Property(body, "usage");
        var diagnostics = new ResolutionDiagnostics
        {
            TimingsMs = new Dictionary<string, double> { ["provider"] = providerTimer.Elapsed.TotalMilliseconds },
            Model = ReadString(body, "model"),
            Provider = ReadString(body, "provider"),
            GenerationId = ReadString(body, "id"),
            FinishReason = finishReason,
            Usage =
                usage.ValueKind == JsonValueKind.Object
                    ? new ModelUsage(
                        ReadCount(usage, "prompt_tokens"),
                        ReadCount(usage, "completion_tokens"),
                        ReadCount(usage, "total_tokens"),
                        ReadCount(Property(usage, "completion_tokens_details"), "reasoning_tokens"),
                        ReadCount(Property(usage, "prompt_tokens_details"), "cached_tokens"),
                        Property(usage, "cost") is { ValueKind: JsonValueKind.Number } cost
                        && cost.TryGetDecimal(out var amount)
                        && amount >= 0
                            ? amount
                            : null
                    )
                    : null,
        };
        var error = Property(body, "error");
        if (error.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
        {
            error = Property(choice, "error");
        }
        var content = ReadString(message, "content");
        var code =
            !response.IsSuccessStatusCode || error.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null)
                ? ErrorCode((int)response.StatusCode, error)
            : finishReason == "length" ? "provider_truncated_response"
            : finishReason == "content_filter" || !string.IsNullOrEmpty(ReadString(message, "refusal"))
                ? "provider_refused"
            : finishReason != "stop"
            || message.ValueKind != JsonValueKind.Object
            || !message.TryGetProperty("content", out _)
                ? "provider_malformed_response"
            : string.IsNullOrWhiteSpace(content) ? "provider_empty_response"
            : null;
        return new ProviderCompletion(
            content,
            diagnostics with
            {
                Code = code,
                CostEstimate = await EstimateCostAsync(diagnostics, cancellationToken),
            }
        );
    }

    private async Task<ModelCostEstimate?> EstimateCostAsync(
        ResolutionDiagnostics diagnostics,
        CancellationToken cancellationToken
    )
    {
        if (
            diagnostics.Usage is not { InputTokens: { } inputTokens, OutputTokens: { } outputTokens }
            || diagnostics.Model?.Split('/') is not { Length: 2 } model
            || string.IsNullOrWhiteSpace(diagnostics.Provider)
        )
        {
            return null;
        }
        try
        {
            using var client = clients.CreateClient("openrouter");
            client.BaseAddress = new Uri(endpoint);
            client.Timeout = TimeSpan.FromSeconds(2);
            using var request = new HttpRequestMessage(
                HttpMethod.Get,
                $"models/{Uri.EscapeDataString(model[0])}/{Uri.EscapeDataString(model[1])}/endpoints"
            );
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
            using var response = await client.SendAsync(request, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }
            var body = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken);
            var endpoints = Property(Property(body, "data"), "endpoints");
            if (endpoints.ValueKind != JsonValueKind.Array)
            {
                return null;
            }
            var prices = endpoints
                .EnumerateArray()
                .Where(route =>
                    string.Equals(
                        ReadString(route, "provider_name"),
                        diagnostics.Provider,
                        StringComparison.OrdinalIgnoreCase
                    )
                )
                .Select(route => Property(route, "pricing"))
                .ToArray();
            if (
                prices.Length == 0
                || prices.Any(price => Property(price, "overrides").ValueKind == JsonValueKind.Array)
            )
            {
                return null;
            }
            var rates = prices
                .Select(price =>
                    (
                        Input: ReadPrice(price, "prompt"),
                        Output: ReadPrice(price, "completion"),
                        Request: Property(price, "request").ValueKind == JsonValueKind.Undefined
                            ? 0m
                            : ReadPrice(price, "request")
                    )
                )
                .Distinct()
                .ToArray();
            if (rates is not [{ Input: { } inputRate, Output: { } outputRate, Request: { } requestRate }])
            {
                return null;
            }
            // ponytail: listed token rates before cache discounts; reported usage cost remains authoritative.
            var inputCost = inputTokens * inputRate;
            var outputCost = outputTokens * outputRate;
            return new ModelCostEstimate(
                inputRate * 1_000_000,
                outputRate * 1_000_000,
                inputCost,
                outputCost,
                requestRate,
                inputCost + outputCost + requestRate,
                DateTimeOffset.UtcNow
            );
        }
        catch (Exception error)
            when (error is HttpRequestException or JsonException or OverflowException
                || error is OperationCanceledException && !cancellationToken.IsCancellationRequested
            )
        {
            // Optional pricing must not discard a completed selection or its reported usage.
            return null;
        }
    }

    private static decimal? ReadPrice(JsonElement pricing, string name) =>
        decimal.TryParse(ReadString(pricing, name), NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
        && value >= 0
            ? value
            : null;

    private static string ErrorCode(int status, JsonElement error)
    {
        var type = ReadString(Property(error, "metadata"), "error_type");
        if (
            Property(error, "code") is { ValueKind: JsonValueKind.Number } code
            && code.TryGetInt32(out var errorStatus)
        )
        {
            status = errorStatus;
        }
        return type switch
        {
            "authentication" => "provider_authentication",
            "rate_limit_exceeded" => "provider_rate_limited",
            "timeout" => "provider_timeout",
            "refusal" or "content_policy_violation" => "provider_refused",
            "max_tokens_exceeded" => "provider_truncated_response",
            _ => status switch
            {
                401 => "provider_authentication",
                402 => "provider_credits",
                403 => "provider_refused",
                408 or 504 or 524 => "provider_timeout",
                429 => "provider_rate_limited",
                400 or 413 or 422 => "provider_request_rejected",
                _ => "provider_unavailable",
            },
        };
    }

    private static JsonElement Property(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var property) ? property : default;

    private static string? ReadString(JsonElement value, string name) =>
        Property(value, name) is { ValueKind: JsonValueKind.String } property ? property.GetString() : null;

    private static long? ReadCount(JsonElement value, string name) =>
        Property(value, name) is { ValueKind: JsonValueKind.Number } property
        && property.TryGetInt64(out var count)
        && count >= 0
            ? count
            : null;
}
