using System.Globalization;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Xpathed.Common.Contracts;
using PricingRates = (decimal Input, decimal Output, decimal Request, System.DateTimeOffset FetchedAt);

namespace Xpathed.Resolver.Services;

public sealed partial class OpenRouterGateway
{
    private static readonly object PricingSync = new();

    private ModelCostEstimate? EstimateCost(
        ResolutionDiagnostics diagnostics,
        CancellationToken cancellationToken,
        string? pricingModel = null
    )
    {
        if (
            diagnostics.Usage is not { InputTokens: { } inputTokens, OutputTokens: { } outputTokens }
            || (pricingModel ?? diagnostics.Model)?.Split('/') is not { Length: 2 } model
            || string.IsNullOrWhiteSpace(diagnostics.Provider)
        )
        {
            return null;
        }
        var key = (typeof(OpenRouterGateway), endpoint, pricingModel ?? diagnostics.Model, diagnostics.Provider);
        Task<PricingRates?> pending;
        lock (PricingSync)
        {
            if (!pricingCache.TryGetValue(key, out pending!))
            {
                pending = FetchPricingAsync(model, diagnostics.Provider, cancellationToken);
                // Share in-flight and unavailable lookups as well as successful rates.
                pricingCache.Set(key, pending, TimeSpan.FromMinutes(5));
            }
        }
        if (!pending.IsCompletedSuccessfully || pending.Result is not { } rates)
        {
            return null;
        }
        try
        {
            // Listed rates exclude cache discounts; reported usage cost remains authoritative.
            var inputCost = inputTokens * rates.Input;
            var outputCost = outputTokens * rates.Output;
            return new ModelCostEstimate(
                rates.Input * 1_000_000,
                rates.Output * 1_000_000,
                inputCost,
                outputCost,
                rates.Request,
                inputCost + outputCost + rates.Request,
                rates.FetchedAt
            );
        }
        catch (OverflowException)
        {
            return null;
        }
    }

    private async Task<PricingRates?> FetchPricingAsync(
        string[] model,
        string provider,
        CancellationToken cancellationToken
    )
    {
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
                    string.Equals(ReadString(route, "provider_name"), provider, StringComparison.OrdinalIgnoreCase)
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
            var distinctRates = prices
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
            return distinctRates is [{ Input: { } inputRate, Output: { } outputRate, Request: { } requestRate }]
                ? (inputRate, outputRate, requestRate, DateTimeOffset.UtcNow)
                : null;
        }
        catch (Exception error)
            when (error
                    is HttpRequestException
                        or JsonException
                        or OperationCanceledException
                        or ObjectDisposedException
            )
        {
            // Optional metadata never holds up target verification or reported provider accounting.
            return null;
        }
    }

    private static decimal? ReadPrice(JsonElement pricing, string name) =>
        decimal.TryParse(ReadString(pricing, name), NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
        && value >= 0
            ? value
            : null;
}
