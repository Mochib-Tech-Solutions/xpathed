using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Xpathed.Resolver.Services;

internal sealed class ContextPlanner(IHttpClientFactory clients, IConfiguration configuration)
{
    internal const string PromptSuffix =
        "\nEvaluation evidence policy jev-v1: evidenceAvailability marks geometry and appearance as included or not_requested. A not_requested group was deliberately omitted; it does not establish absence or normal appearance. Never infer missing visual evidence from labels or candidate order. If identifying a target requires omitted evidence, abstain rather than guess.";
    private const double NegativeThreshold = 0.05;
    private const int TimeoutMs = 500;
    internal static object Questions =>
        new
        {
            appearance = new
            {
                type = "noul",
                instructions = "Does identifying any requested target or reference element require visual color or appearance evidence, including background, foreground, border, image or icon appearance?",
            },
            layout = new
            {
                type = "noul",
                instructions = "Does identifying or ordering any requested target or reference element require visual position, direction, distance, size or spatial relations?",
            },
        };
    internal static object Policy =>
        new
        {
            version = "jev-v1",
            model = "typesafe/jev-1.13",
            responseModel = "typesafe/jev-1.13-20260917",
            questions = Questions,
            negativeThreshold = NegativeThreshold,
            positiveThreshold = 1 - NegativeThreshold,
            timeoutMs = TimeoutMs,
            fallback = "full_evidence",
            provider = Provider,
        };
    private static object Provider =>
        new
        {
            only = new[] { "typesafe" },
            order = new[] { "typesafe" },
            allow_fallbacks = false,
        };

    internal async Task<(ContextEvidenceSelection Selection, object Evidence)> PlanAsync(
        string instruction,
        CancellationToken cancellationToken
    )
    {
        var timer = Stopwatch.StartNew();
        var selection = new ContextEvidenceSelection(true, true);
        double? appearance = null,
            layout = null;
        string? generationId = null;
        decimal? cost = null;
        long? inputTokens = null,
            outputTokens = null;
        var status = "fallback_error";
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromMilliseconds(TimeoutMs));
        try
        {
            using var client = clients.CreateClient("openrouter");
            var endpoint = new Uri(
                new Uri(configuration["OpenRouter:BaseUrl"] ?? "https://openrouter.ai/api/v1/"),
                "/api/alpha/decisions"
            );
            using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", configuration["OpenRouter:ApiKey"]);
            request.Content = JsonContent.Create(
                new
                {
                    model = "typesafe/jev-1.13",
                    state = instruction,
                    questions = Questions,
                    provider = Provider,
                }
            );
            using var response = await client.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                deadline.Token
            );
            response.EnsureSuccessStatusCode();
            await using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
            var buffer = new byte[16385];
            var length = await stream.ReadAtLeastAsync(buffer, buffer.Length, false, deadline.Token);
            if (length > 16384)
            {
                throw new JsonException();
            }
            using var document = JsonDocument.Parse(buffer.AsMemory(0, length));
            var root = document.RootElement;
            if (
                root.ValueKind != JsonValueKind.Object
                || root.EnumerateObject()
                    .Any(property => property.Name is not ("id" or "model" or "provider" or "answers" or "usage"))
                || root.EnumerateObject().Select(property => property.Name).Distinct(StringComparer.Ordinal).Count()
                    != root.EnumerateObject().Count()
                || root.GetProperty("model").GetString() != "typesafe/jev-1.13-20260917"
                || root.GetProperty("provider").GetString() != "TypeSafe"
            )
            {
                throw new JsonException();
            }
            var answers = root.GetProperty("answers");
            if (answers.ValueKind != JsonValueKind.Object || answers.EnumerateObject().Count() != 2)
            {
                throw new JsonException();
            }
            appearance = Probability(answers.GetProperty("appearance"));
            layout = Probability(answers.GetProperty("layout"));
            if (
                root.TryGetProperty("id", out var id)
                && id.ValueKind == JsonValueKind.String
                && id.GetString() is { Length: <= 200 } identifier
                && identifier.StartsWith("gen-", StringComparison.Ordinal)
            )
            {
                generationId = identifier;
            }
            if (root.TryGetProperty("usage", out var usage) && usage.ValueKind == JsonValueKind.Object)
            {
                if (usage.TryGetProperty("cost", out var charge) && charge.TryGetDecimal(out var amount) && amount >= 0)
                {
                    cost = amount;
                }
                if (
                    usage.TryGetProperty("input_tokens", out var input)
                    && input.TryGetInt64(out var count)
                    && count >= 0
                )
                {
                    inputTokens = count;
                }
                if (
                    usage.TryGetProperty("output_tokens", out var output)
                    && output.TryGetInt64(out count)
                    && count >= 0
                )
                {
                    outputTokens = count;
                }
            }
            if (
                appearance > NegativeThreshold && appearance < 1 - NegativeThreshold
                || layout > NegativeThreshold && layout < 1 - NegativeThreshold
            )
            {
                status = "fallback_uncertain";
            }
            else
            {
                selection = new ContextEvidenceSelection(appearance > NegativeThreshold, layout > NegativeThreshold);
                status = "classified";
            }
        }
        catch (OperationCanceledException)
        {
            status = "fallback_timeout";
        }
        catch (Exception error)
            when (error
                    is HttpRequestException
                        or JsonException
                        or KeyNotFoundException
                        or InvalidOperationException
                        or IOException
            )
        {
            status = "fallback_error";
        }
        return (
            selection,
            new
            {
                status,
                elapsedMs = timer.Elapsed.TotalMilliseconds,
                appearanceProbability = appearance,
                layoutProbability = layout,
                choice = new { appearance = selection.Appearance, geometry = selection.Geometry },
                generationId,
                usage = new
                {
                    inputTokens,
                    outputTokens,
                    cost,
                },
            }
        );
    }

    private static double Probability(JsonElement answer)
    {
        if (
            answer.ValueKind != JsonValueKind.Object
            || answer.EnumerateObject().Count() != 2
            || answer.GetProperty("type").GetString() != "noul"
            || !answer.GetProperty("noul").TryGetDouble(out var value)
            || !double.IsFinite(value)
            || value < 0
            || value > 1
        )
        {
            throw new JsonException();
        }
        return value;
    }
}
