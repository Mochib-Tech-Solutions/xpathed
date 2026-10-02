using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Unicode;
using Xpathed.Common.Contracts;

namespace Xpathed.Resolver.Services;

internal static class CandidateInput
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Encoder = JavaScriptEncoder.Create(UnicodeRanges.All),
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static string PrepareInput(string instruction, CandidateCapture capture) =>
        JsonSerializer.Serialize(
            new
            {
                instruction,
                scope = capture.Scope,
                capture.FrameId,
                candidates = capture.Candidates.Select(candidate => new
                {
                    candidate.Id,
                    candidate.Tag,
                    role = string.IsNullOrEmpty(candidate.Role) ? null : candidate.Role,
                    text = string.IsNullOrEmpty(candidate.Text) || candidate.Text == candidate.Label
                        ? null
                        : candidate.Text,
                    label = string.IsNullOrEmpty(candidate.Label) ? null : candidate.Label,
                    placeholder = string.IsNullOrEmpty(candidate.Placeholder) ? null : candidate.Placeholder,
                    scope = candidate.Scope.Length == 0 ? null : candidate.Scope,
                    state = new
                    {
                        rendered = candidate.State.Rendered ? (bool?)null : candidate.State.Rendered,
                        enabled = candidate.State.Enabled ? (bool?)null : candidate.State.Enabled,
                        editable = !candidate.State.Editable ? (bool?)null : candidate.State.Editable,
                        @readonly = candidate.State.Readonly != true ? null : candidate.State.Readonly,
                    },
                    geometry = candidate.Geometry,
                    appearance = candidate.Appearance is { } appearance
                        ? new
                        {
                            appearance.BackgroundColor,
                            appearance.TextColor,
                            appearance.BorderColor,
                            limitations = appearance.Limitations.Length == 0 ? null : appearance.Limitations,
                        }
                        : null,
                    frame = candidate.Frame is null
                        ? null
                        : new { candidate.Frame.Id, labels = candidate.Frame.Chain.Select(ancestor => ancestor.Label) },
                }),
            },
            JsonOptions
        );
}
