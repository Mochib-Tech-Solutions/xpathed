using System.Diagnostics;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Unicode;
using Xpathed.Common.Contracts;
using Xpathed.Common.Diagnostics;
using Xpathed.Common.Http;

namespace Xpathed.Resolver.Services;

public static class OfflineSelectionEvaluation
{
    private const int InputBudgetBytes = 512000;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Encoder = JavaScriptEncoder.Create(UnicodeRanges.All),
    };
    private static readonly string[] CandidateFields = ["id", "tag", "role", "text", "label", "placeholder", "scope"];

    public static async Task<int> RunAsync(string[] args)
    {
        var timer = Stopwatch.StartNew();
        string? configurationId = null;
        var prompt = ActionSelectionStrategy.SingleInteractionPrompt;
        var promptVersion = "7";
        var diagnostics = new ResolutionDiagnostics
        {
            Stage = "input",
            Strategy = "candidate-selection-offline-v1",
            PromptVersion = promptVersion,
        };
        try
        {
            if (args.Length is < 2 or > 3 || args.Length == 3 && args[2] != "--prepare-only")
            {
                throw new ApiException(
                    400,
                    "invalid_offline_arguments",
                    "Use --evaluate-offline INPUT [--prepare-only]."
                );
            }
            var variant = Environment.GetEnvironmentVariable("XPATHED_EVALUATION_PROMPT_VARIANT");
            if (variant is not (null or "baseline" or "declarative-inspect"))
            {
                throw new ApiException(400, "invalid_offline_prompt_variant", "Unknown offline prompt variant.");
            }
            if (variant == "declarative-inspect")
            {
                prompt +=
                    "\nAn element description without an explicit interaction is an inspect request. "
                    + "Identify its intended candidate using available text and scope; absence of an action verb alone is not unsupported_action. "
                    + "Keep genuine ambiguity unsupported and preserve all existing plural and workflow rules.";
                promptVersion = "7-declarative-inspect-1";
            }
            diagnostics = diagnostics with { PromptVersion = promptVersion };
            var input = await ReadInputAsync(args[1]);
            using var inputDocument = JsonDocument.Parse(input);
            var candidateIds = inputDocument
                .RootElement.GetProperty("candidates")
                .EnumerateArray()
                .Select(candidate => candidate.GetProperty("id").GetString()!)
                .ToArray();
            diagnostics = diagnostics with
            {
                ModelInputBytes = Encoding.UTF8.GetByteCount(input),
                ModelInputCount = candidateIds.Length,
                ModelInputComplete = true,
            };
            var builder = Host.CreateApplicationBuilder();
            builder.Logging.ClearProviders();
            builder.Services.AddHttpClient("openrouter");
            builder.Services.AddTransient<OpenRouterGateway>();
            using var host = builder.Build();
            var gateway = host.Services.GetRequiredService<OpenRouterGateway>();
            if (Environment.GetEnvironmentVariable("XPATHED_EVALUATION_PRICE_LIMITS") is { Length: > 0 } limits)
            {
                var prices = JsonSerializer.Deserialize<Dictionary<string, decimal>>(limits);
                if (
                    prices is null
                    || prices.Count != 3
                    || !prices.TryGetValue("prompt", out var promptPrice)
                    || promptPrice <= 0
                    || !prices.TryGetValue("completion", out var completionPrice)
                    || completionPrice <= 0
                    || !prices.TryGetValue("request", out var requestPrice)
                    || requestPrice < 0
                )
                {
                    throw new JsonException();
                }
                gateway.EvaluationPriceLimits = prices;
            }
            configurationId = gateway.ConfigurationId(
                diagnostics.Strategy,
                prompt,
                ActionSelectionStrategy.Schema,
                InputBudgetBytes,
                ActionSelectionStrategy.OutputTokens,
                promptVersion,
                ActionSelectionStrategy.MaximumActions
            );
            if (args.Length == 3)
            {
                await Console.Out.WriteLineAsync(
                    JsonSerializer.Serialize(
                        new
                        {
                            modelInput = input,
                            prompt,
                            schema = ActionSelectionStrategy.Schema,
                            outputTokens = ActionSelectionStrategy.OutputTokens,
                            configurationId,
                            promptVersion,
                            effective = gateway.DescribeConfiguration(
                                diagnostics.Strategy,
                                prompt,
                                ActionSelectionStrategy.Schema,
                                InputBudgetBytes,
                                ActionSelectionStrategy.OutputTokens,
                                promptVersion,
                                ActionSelectionStrategy.MaximumActions
                            ),
                        },
                        JsonOptions
                    )
                );
                return 0;
            }
            diagnostics = diagnostics with { Stage = "configuration" };
            gateway.EnsureConfigured();
            diagnostics = diagnostics with { Stage = "model", ModelCalls = 1 };
            var completion = await gateway.CompleteAsync(
                prompt,
                input,
                ActionSelectionStrategy.Schema,
                CancellationToken.None,
                ActionSelectionStrategy.OutputTokens
            );
            diagnostics = completion.Diagnostics with
            {
                Stage = "selection",
                Strategy = diagnostics.Strategy,
                PromptVersion = promptVersion,
                ModelCalls = 1,
                ModelInputBytes = diagnostics.ModelInputBytes,
                ModelInputCount = candidateIds.Length,
                ModelInputComplete = true,
            };
            if (diagnostics.Code is { } code)
            {
                throw new ApiException(502, code, "The provider could not return a valid selection.");
            }
            var selections = ActionSelectionStrategy.Select(completion.Content!, candidateIds, singleInteraction: true);
            diagnostics = diagnostics with { Stage = "complete" };
            var outcomes = selections.Select(item => item.Outcome).Distinct(StringComparer.Ordinal).ToArray();
            await WriteResultAsync(outcomes.Length == 1 ? outcomes[0] : "partial", selections);
            return 0;
        }
        catch (Exception error)
            when (error
                    is ApiException
                        or JsonException
                        or IOException
                        or UnauthorizedAccessException
                        or KeyNotFoundException
                        or HttpRequestException
                        or OperationCanceledException
            )
        {
            diagnostics = diagnostics with
            {
                Code = error switch
                {
                    ApiException api => api.Code,
                    OperationCanceledException => "provider_timeout",
                    HttpRequestException => "provider_unavailable",
                    _ => "invalid_offline_input",
                },
            };
            await WriteResultAsync("error", []);
            return 1;
        }

        async Task WriteResultAsync(string outcome, ModelActionSelection[] selections)
        {
            diagnostics.TimingsMs["total"] = timer.Elapsed.TotalMilliseconds;
            var value = JsonSerializer.Serialize(
                new
                {
                    outcome,
                    action = selections.FirstOrDefault()?.Action,
                    actions = selections,
                    diagnostics,
                    configurationId,
                    promptVersion,
                    inputBytes = diagnostics.ModelInputBytes,
                    providerLatencyMs = diagnostics.TimingsMs.TryGetValue("provider", out var elapsed)
                        ? (double?)elapsed
                        : null,
                },
                JsonOptions
            );
            await Console.Out.WriteLineAsync(DiagnosticSanitizer.SanitizeJson(value));
        }
    }

    private static async Task<string> ReadInputAsync(string path)
    {
        await using var file = File.OpenRead(path);
        var buffer = new byte[InputBudgetBytes + 1];
        var length = await file.ReadAtLeastAsync(buffer, buffer.Length, throwOnEndOfStream: false);
        if (length > InputBudgetBytes)
        {
            throw new ApiException(422, "model_input_budget_exceeded", "Offline input exceeds the model input budget.");
        }
        using var document = JsonDocument.Parse(buffer.AsMemory(0, length));
        var root = document.RootElement;
        RequireFields(root, ["instruction", "candidates"]);
        var instruction = Text(root.GetProperty("instruction"), 4000);
        if (string.IsNullOrWhiteSpace(instruction))
        {
            throw new JsonException();
        }

        var items = root.GetProperty("candidates");
        if (items.ValueKind != JsonValueKind.Array)
        {
            throw new JsonException();
        }

        var candidates = new List<Dictionary<string, object>>();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in items.EnumerateArray())
        {
            RequireFields(item, CandidateFields);
            var id = Text(item.GetProperty("id"), 80);
            var tag = Text(item.GetProperty("tag"), 64);
            if (
                string.IsNullOrWhiteSpace(id)
                || !ids.Add(id)
                || string.IsNullOrWhiteSpace(tag)
                || !id.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_')
            )
            {
                throw new JsonException();
            }

            var candidate = new Dictionary<string, object>(StringComparer.Ordinal) { ["id"] = id, ["tag"] = tag };
            foreach (var property in item.EnumerateObject().Where(property => property.Name is not ("id" or "tag")))
            {
                if (property.Name == "scope")
                {
                    if (property.Value.ValueKind != JsonValueKind.Array || property.Value.GetArrayLength() > 32)
                    {
                        throw new JsonException();
                    }

                    candidate[property.Name] = property
                        .Value.EnumerateArray()
                        .Select(value => Text(value, 4000))
                        .ToArray();
                }
                else
                {
                    candidate[property.Name] = Text(property.Value, 4000);
                }
            }
            candidates.Add(candidate);
        }
        var input = JsonSerializer.Serialize(new { instruction, candidates }, JsonOptions);
        if (Encoding.UTF8.GetByteCount(input) > InputBudgetBytes)
        {
            throw new ApiException(422, "model_input_budget_exceeded", "Offline input exceeds the model input budget.");
        }

        return input;
    }

    private static void RequireFields(JsonElement value, string[] allowed)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            throw new JsonException();
        }

        var names = value.EnumerateObject().Select(property => property.Name).ToArray();
        if (
            names.Any(name => !allowed.Contains(name, StringComparer.Ordinal))
            || names.Distinct(StringComparer.Ordinal).Count() != names.Length
        )
        {
            throw new JsonException();
        }
    }

    private static string Text(JsonElement value, int maximumLength)
    {
        if (value.ValueKind != JsonValueKind.String || value.GetString()!.Length > maximumLength)
        {
            throw new JsonException();
        }

        return DiagnosticSanitizer.SanitizeText(value.GetString())!;
    }
}
