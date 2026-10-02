using System.Text.RegularExpressions;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Resolver.Services;

internal static partial class BrowserEvidence
{
    internal static void ValidateCapture(CandidateCapture capture, string pageId, string documentId)
    {
        if (
            capture.Coverage is null
            || capture.Candidates is null
            || string.IsNullOrWhiteSpace(capture.SessionId)
            || string.IsNullOrWhiteSpace(capture.CaptureId)
            || capture.FrameId != "main"
            || capture.UnsupportedBoundaryCount < 0
            || capture.Scope != "current_view"
        )
        {
            throw new ApiException(502, "invalid_browser_capture", "The browser returned an invalid capture.");
        }
        if (capture.PageId != pageId || capture.DocumentId != documentId)
        {
            throw new ApiException(409, "stale_document", "The browser capture belongs to another page or document.");
        }
        if (!capture.Coverage.Complete)
        {
            throw new ApiException(
                502,
                "capture_incomplete",
                "The browser could not capture every eligible candidate."
            );
        }
        if (
            capture.Coverage.CapturedCount != capture.Candidates.Length
            || capture.Coverage.ExcludedOffscreenCount < 0
            || capture.Coverage.EligibleCount
                != (long)capture.Candidates.Length + capture.Coverage.ExcludedOffscreenCount
            || capture.Coverage.ScannedCount < capture.Coverage.EligibleCount
            || capture.Candidates.Any(candidate =>
                candidate is null
                || string.IsNullOrWhiteSpace(candidate.Id)
                || candidate.Id.Length > 80
                || candidate.Tag is null
                || candidate.Role is null
                || candidate.Text is null
                || candidate.Label is null
                || candidate.Placeholder is null
                || candidate.Scope is null
                || candidate.State is null
                || candidate.Geometry is null
                || !ValidCurrentViewCandidate(candidate)
                || !ValidFrame(candidate.Frame, documentId)
            )
            || capture.Candidates.Select(candidate => candidate.Id).Distinct(StringComparer.Ordinal).Count()
                != capture.Candidates.Length
        )
        {
            throw new ApiException(
                502,
                "invalid_browser_capture",
                "The browser returned inconsistent candidates or coverage."
            );
        }
    }

    internal static ActionSelectionValidation ValidateSelection(
        CandidateCapture capture,
        ModelActionSelection[] selections,
        ActionSelection[] requestedActions,
        ActionSelectionValidation? validation
    )
    {
        if (validation?.Actions is null || validation.Actions.Length != selections.Length)
        {
            throw new ApiException(502, "invalid_browser_selection", "The browser did not verify every action.");
        }
        for (var index = 0; index < selections.Length; index++)
        {
            var selection = selections[index];
            var verified = validation.Actions[index];
            if (
                verified is null
                || verified.ActionId != requestedActions[index].ActionId
                || (
                    selection.Outcome == "found"
                        ? !ValidTarget(
                            verified.Target,
                            selection.CandidateId,
                            selection.Action,
                            capture.Candidates.Single(candidate => candidate.Id == selection.CandidateId).Frame
                        )
                            || verified.Target?.State?.InViewport != true
                        : verified.Target is not null
                )
            )
            {
                throw new ApiException(
                    502,
                    "invalid_browser_selection",
                    "The browser did not verify every action's target."
                );
            }
        }
        var inspected = validation.Actions.FirstOrDefault(action => action.Target is not null)?.ActionId;
        if (validation.InspectedActionId != inspected)
        {
            throw new ApiException(502, "invalid_browser_selection", "The browser inspected another action.");
        }
        return validation;
    }

    private static bool ValidCurrentViewCandidate(CandidateElement candidate) =>
        candidate.State.InViewport
        && double.IsFinite(candidate.Geometry.X)
        && double.IsFinite(candidate.Geometry.Y)
        && double.IsFinite(candidate.Geometry.Width)
        && candidate.Geometry.Width > 0
        && double.IsFinite(candidate.Geometry.Height)
        && candidate.Geometry.Height > 0
        && candidate.Appearance is { Limitations: { Length: <= 8 } } appearance
        && (appearance.BackgroundColor is null || OpaqueColor().IsMatch(appearance.BackgroundColor))
        && (appearance.TextColor is null || OpaqueColor().IsMatch(appearance.TextColor))
        && (appearance.BorderColor is null || OpaqueColor().IsMatch(appearance.BorderColor))
        && appearance.Limitations.All(value =>
            value
                is "complex_effects"
                    or "background_image"
                    or "pseudo_element_appearance"
                    or "replaced_content"
                    or "background_transparent"
                    or "unsupported_color"
                    or "mixed_border_colors"
        );

    [GeneratedRegex(
        @"^rgb\((?:0|[1-9]\d?|1\d{2}|2[0-4]\d|25[0-5]), (?:0|[1-9]\d?|1\d{2}|2[0-4]\d|25[0-5]), (?:0|[1-9]\d?|1\d{2}|2[0-4]\d|25[0-5])\)$",
        RegexOptions.CultureInvariant
    )]
    private static partial Regex OpaqueColor();

    private static bool ValidTarget(ResolvedTarget? target, string? candidateId, string action, TargetFrame? frame) =>
        target is not null
        && SameFrame(target.Frame, frame)
        && target.CandidateId == candidateId
        && target.Xpaths is { Length: 1 }
        && !target.Xpaths.Any(string.IsNullOrWhiteSpace)
        && target.State is not null
        && target.Geometry is not null
        && ValidInteractability(target, action);

    private static bool ValidFrame(TargetFrame? frame, string documentId) =>
        frame is null
        || !string.IsNullOrWhiteSpace(frame.Id)
            && !string.IsNullOrWhiteSpace(frame.DocumentId)
            && frame.Chain is { Length: <= 63 }
            && (
                frame.Id == "main"
                    ? frame.Chain.Length == 0 && frame.DocumentId == documentId
                    : frame.Chain.Length > 0 && frame.Chain[^1]?.FrameId == frame.Id
            )
            && frame.Chain.All(ancestor =>
                ancestor is not null
                && !string.IsNullOrWhiteSpace(ancestor.FrameId)
                && !string.IsNullOrWhiteSpace(ancestor.Xpath)
                && ancestor.Label is not null
            )
            && frame.Chain.Select(ancestor => ancestor.FrameId).Distinct(StringComparer.Ordinal).Count()
                == frame.Chain.Length;

    private static bool SameFrame(TargetFrame? actual, TargetFrame? expected) =>
        actual is null
            ? expected is null
            : expected is not null
                && actual.Id == expected.Id
                && actual.DocumentId == expected.DocumentId
                && actual.Chain is not null
                && actual.Chain.SequenceEqual(expected.Chain);

    private static bool ValidInteractability(ResolvedTarget target, string action)
    {
        var assessment = target.Interactability;
        if (assessment?.Checks is not { } checks)
        {
            return false;
        }
        string[] readiness =
        [
            checks.CompatibleControl,
            checks.Enabled,
            checks.Writable,
            checks.Viewport,
            checks.PointerReception,
            checks.Keyboard,
        ];
        string[] values = [.. readiness, checks.Stability, checks.EventOutcome];
        return target.State.Version == "2"
            && target.State.AccessibilityExposed == true
            && target.State.Readonly is not null
            && assessment is { Version: "2", Reasons: not null, Checks: not null }
            && assessment.Action == action
            && assessment.Status is "ready" or "blocked" or "unknown" or "unsupported"
            && assessment.Reasons.All(reason => !string.IsNullOrWhiteSpace(reason))
            && values.All(value => value is "pass" or "fail" or "unknown" or "not_applicable")
            && checks.EventOutcome == "unknown"
            && (
                assessment.Status != "ready"
                || readiness.All(value => value is "pass" or "not_applicable")
                    && readiness.Contains("pass", StringComparer.Ordinal)
            )
            && (assessment.Status == "blocked") == values.Contains("fail", StringComparer.Ordinal);
    }
}
