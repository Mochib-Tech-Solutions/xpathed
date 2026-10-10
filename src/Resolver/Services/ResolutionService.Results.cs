using Xpathed.Common.Contracts;

namespace Xpathed.Resolver.Services;

public sealed partial class ResolutionService
{
    private static ActionResolution[] BuildActions(
        ModelActionSelection[] selections,
        ActionSelectionValidation validation,
        CandidateCapture capture,
        string attemptId
    )
    {
        return selections
            .Select(
                (item, index) =>
                {
                    var verified = validation.Actions[index];
                    var unsupportedScope = item.Outcome == "not_found" && capture.UnsupportedBoundaryCount > 0;
                    var code =
                        unsupportedScope ? "unsupported_scope"
                        : item.Limitation == "none" ? null
                        : item.Limitation;
                    var message = unsupportedScope
                        ? "Frame or shadow content is outside this capture's supported scope."
                        : item.Limitation switch
                        {
                            "current_state_dependency" =>
                                "This command requires separate steps or a page change. No action was executed.",
                            "appearance_unavailable" =>
                                "The requested appearance cannot be established from the captured view.",
                            "state_unavailable" =>
                                "The checked, selected or form-value distinction is not available. Identify the target by its name, section or position.",
                            "target_not_addressable" =>
                                "The requested detail has no separate captured element. Choose the whole graphic or a separately exposed control.",
                            "ambiguous" => "The instruction does not identify one intended target.",
                            "unsupported_action" =>
                                "Use one supported interaction type per command. It may target several elements in the current view; mixed interactions are unsupported.",
                            _ => item.Outcome == "not_found" ? "No matching element found in the current view." : null,
                        };
                    return new ActionResolution(
                        verified.ActionId,
                        index + 1,
                        item.Step,
                        item.Instruction,
                        item.Action,
                        unsupportedScope ? "unsupported" : item.Outcome,
                        verified.Target,
                        verified.Target?.Frame?.Id ?? capture.FrameId,
                        attemptId,
                        code,
                        message
                    );
                }
            )
            .ToArray();
    }

    private static ResolutionSummary BuildSummary(ActionResolution[] results)
    {
        return new ResolutionSummary(
            true,
            "unverified",
            results.Length,
            results.Count(item => item.Outcome == "found"),
            results.Count(item => item.Outcome == "not_found"),
            results.Count(item => item.Outcome == "unsupported"),
            0,
            results.Count(item => item.Target?.Interactability?.Status == "blocked"),
            results.Count(item =>
                item.Target is { Interactability: null } || item.Target?.Interactability?.Status == "unknown"
            ),
            results.Count(item => item.Target?.Interactability?.Status == "unsupported")
        );
    }
}
