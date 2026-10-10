using System.Text;
using System.Text.Json;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Resolver.Services;

internal static class ActionSelectionStrategy
{
    public const string Strategy = "candidate-selection";
    public const int MaximumActions = 16;
    public const int OutputTokens = 4096;

    public static string Prompt { get; } = ReadResource("action-selection.txt");

    public static readonly JsonElement Schema = JsonSerializer.Deserialize<JsonElement>(
        ReadResource("action-selection.schema.json")
    );

    public static ModelActionSelection[] Select(string content, CandidateCapture capture) =>
        Select(content, capture.Candidates.Select(candidate => candidate.Id).ToArray());

    public static ModelActionSelection[] Select(string content, string[] candidateIds)
    {
        if (Encoding.UTF8.GetByteCount(content) > 16000)
        {
            throw new ApiException(
                422,
                "action_output_budget_exceeded",
                "The complete action list exceeds the output budget."
            );
        }
        try
        {
            using var document = JsonDocument.Parse(content);
            var root = document.RootElement;
            if (
                root.ValueKind != JsonValueKind.Object
                || root.EnumerateObject().Count() != 2
                || !root.TryGetProperty("complete", out var complete)
                || complete.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
                || !root.TryGetProperty("actions", out var actions)
                || actions.ValueKind != JsonValueKind.Array
            )
            {
                throw new JsonException();
            }
            if (actions.GetArrayLength() > MaximumActions)
            {
                throw new ApiException(422, "action_budget_exceeded", "The instruction exceeds the 16-action limit.");
            }
            var selections = actions
                .EnumerateArray()
                .Select(value =>
                {
                    if (
                        value.ValueKind != JsonValueKind.Object
                        || value.EnumerateObject().Count() != 6
                        || !value.TryGetProperty("step", out var step)
                        || !step.TryGetInt32(out var stepNumber)
                        || !value.TryGetProperty("instruction", out var instruction)
                        || instruction.ValueKind != JsonValueKind.String
                        || !value.TryGetProperty("outcome", out var outcome)
                        || outcome.ValueKind != JsonValueKind.String
                        || !value.TryGetProperty("action", out var action)
                        || action.ValueKind != JsonValueKind.String
                        || !value.TryGetProperty("candidateId", out var candidate)
                        || candidate.ValueKind is not (JsonValueKind.String or JsonValueKind.Null)
                        || !value.TryGetProperty("limitation", out var limitation)
                        || limitation.ValueKind != JsonValueKind.String
                    )
                    {
                        throw new JsonException();
                    }
                    var selection = new ModelActionSelection(
                        stepNumber,
                        instruction.GetString()!,
                        outcome.GetString()!,
                        action.GetString()!,
                        candidate.GetString(),
                        limitation.GetString()!
                    );
                    if (
                        selection.Step is < 1 or > MaximumActions
                        || string.IsNullOrWhiteSpace(selection.Instruction)
                        || selection.Instruction.Length > 300
                        || selection.Outcome is not ("found" or "not_found" or "unsupported")
                        || selection.Action
                            is not (
                                "click"
                                or "double_click"
                                or "right_click"
                                or "hover"
                                or "fill"
                                or "type"
                                or "clear"
                                or "select"
                                or "check"
                                or "uncheck"
                                or "press"
                                or "focus"
                                or "blur"
                                or "upload"
                                or "inspect"
                                or "unsupported"
                            )
                        || (
                            selection.Limitation
                                is not ("none" or "ambiguous" or "unsupported_action" or "current_state_dependency")
                            && selection.Limitation
                                is not ("appearance_unavailable" or "state_unavailable" or "target_not_addressable")
                        )
                        || (selection.Outcome == "unsupported") != (selection.Limitation != "none")
                        || (selection.Action == "unsupported" && selection.Outcome != "unsupported")
                        || (selection.Limitation == "unsupported_action" && selection.Action != "unsupported")
                        || (selection.Limitation == "current_state_dependency" && selection.Action == "unsupported")
                        || (
                            selection.Outcome == "found"
                                ? string.IsNullOrWhiteSpace(selection.CandidateId)
                                : selection.CandidateId is not null
                        )
                    )
                    {
                        throw new JsonException();
                    }
                    if (
                        actions.GetArrayLength() == 1
                        && selection.Limitation
                            is "appearance_unavailable"
                                or "state_unavailable"
                                or "target_not_addressable"
                    )
                    {
                        // A valid evidence abstention has no target or executable action.
                        selection = selection with
                        {
                            Action = "unsupported",
                        };
                    }
                    if (selection.CandidateId is { } id && !candidateIds.Contains(id, StringComparer.Ordinal))
                    {
                        throw new ApiException(
                            502,
                            "provider_unknown_candidate",
                            "The model selected a candidate outside the current capture."
                        );
                    }
                    return selection;
                })
                .ToArray();
            if (!complete.GetBoolean())
            {
                throw new ApiException(
                    422,
                    "decomposition_incomplete",
                    "The model returned an incomplete response for this instruction."
                );
            }
            if (
                selections.Length == 0
                || selections.Select(item => (item.Step, item.Action, item.CandidateId)).Distinct().Count()
                    != selections.Length
                || !selections
                    .Select(item => item.Step)
                    .Distinct()
                    .Order()
                    .SequenceEqual(Enumerable.Range(1, selections.Max(item => item.Step)))
                || selections
                    .GroupBy(item => item.Step)
                    .Any(group =>
                        group.Count() > 1
                        && (
                            group.Any(item => item.Outcome != "found")
                            || group.Select(item => item.Action).Distinct().Count() != 1
                        )
                    )
            )
            {
                throw new JsonException();
            }
            if (
                (
                    selections.Select(item => item.Action).Distinct(StringComparer.Ordinal).Count() != 1
                    || selections
                        .Where(item => item.CandidateId is not null)
                        .Select(item => item.CandidateId)
                        .Distinct(StringComparer.Ordinal)
                        .Count() != selections.Count(item => item.CandidateId is not null)
                    || (selections.Length > 1 && selections.Any(item => item.Outcome == "unsupported"))
                )
            )
            {
                throw new JsonException();
            }
            return selections
                .OrderBy(item => item.Step)
                .ThenBy(item =>
                    item.CandidateId is null
                        ? int.MaxValue
                        : Array.FindIndex(candidateIds, candidateId => candidateId == item.CandidateId)
                )
                .ToArray();
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException)
        {
            throw new ApiException(502, "provider_malformed_response", "The model returned an invalid action list.");
        }
    }

    private static string ReadResource(string name)
    {
        using var resource =
            typeof(ActionSelectionStrategy).Assembly.GetManifestResourceStream($"Xpathed.Resolver.Prompts.{name}")
            ?? throw new InvalidOperationException($"The action-selection resource {name} is missing.");
        using var reader = new StreamReader(resource);
        return reader.ReadToEnd();
    }
}
