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

    public static string PrepareInput(string instruction, CandidateCapture capture)
    {
        var peers = capture
            .Candidates.GroupBy(candidate => (candidate.Frame?.Id, candidate.ParentId))
            .ToDictionary(group => group.Key, group => group.ToArray());
        var byId = capture.Candidates.ToDictionary(candidate => candidate.Id, StringComparer.Ordinal);
        var items = capture.Candidates.Where(candidate => candidate.IsRepeatedItem).ToArray();
        var context = new List<object>();
        var contextIds = new Dictionary<string, int>(StringComparer.Ordinal);
        var candidates = capture
            .Candidates.Select(candidate => new
            {
                candidate.Id,
                parentId = items.Length == 0 ? null : candidate.ParentId,
                candidate.Tag,
                role = string.IsNullOrEmpty(candidate.Role) ? null : candidate.Role,
                text = string.IsNullOrEmpty(candidate.Text) || candidate.Text == candidate.Label
                    ? null
                    : candidate.Text,
                label = string.IsNullOrEmpty(candidate.Label) ? null : candidate.Label,
                placeholder = string.IsNullOrEmpty(candidate.Placeholder) ? null : candidate.Placeholder,
                scope = candidate.Scope.Length == 0 ? null : (int?)Share(candidate.Scope),
                state = candidate.State.Rendered
                && candidate.State.Enabled
                && !candidate.State.Editable
                && candidate.State.Readonly != true
                    ? null
                    : new
                    {
                        rendered = candidate.State.Rendered ? (bool?)null : candidate.State.Rendered,
                        enabled = candidate.State.Enabled ? (bool?)null : candidate.State.Enabled,
                        editable = !candidate.State.Editable ? (bool?)null : candidate.State.Editable,
                        @readonly = candidate.State.Readonly != true ? null : candidate.State.Readonly,
                    },
                geometry = new[]
                {
                    candidate.Geometry.X,
                    candidate.Geometry.Y,
                    candidate.Geometry.Width,
                    candidate.Geometry.Height,
                },
                appearance = candidate.Appearance is { } appearance
                && (
                    appearance.BackgroundColor is not null
                    || appearance.TextColor is not null
                    || appearance.BorderColor is not null
                    || appearance.Limitations.Length != 0
                )
                    ? (int?)Share(
                        new
                        {
                            appearance.BackgroundColor,
                            appearance.TextColor,
                            appearance.BorderColor,
                            limitations = appearance.Limitations.Length == 0 ? null : appearance.Limitations,
                        }
                    )
                    : null,
                frame = candidate.Frame is null
                || (candidate.Frame.Id == capture.FrameId && candidate.Frame.Chain.Length == 0)
                    ? null
                    : (int?)Share(
                        new { candidate.Frame.Id, labels = candidate.Frame.Chain.Select(ancestor => ancestor.Label) }
                    ),
            })
            .ToArray();
        return JsonSerializer.Serialize(
            new
            {
                instruction,
                scope = capture.Scope,
                capture.FrameId,
                layout = items.Length == 0
                    ? null
                    : items.Select(item => new
                    {
                        item.Id,
                        description = Description(item),
                        neighbors = Neighbors(
                            item,
                            peers[(item.Frame?.Id, item.ParentId)].Where(peer => peer.IsRepeatedItem).ToArray()
                        )
                            ?.ToDictionary(
                                pair => pair.Key,
                                pair => pair.Value.Select(id => new { id, description = Description(byId[id]) })
                            ),
                    }),
                context = context.Count == 0 ? null : context,
                candidates,
            },
            JsonOptions
        );

        int Share(object value)
        {
            var key = JsonSerializer.Serialize(value, JsonOptions);
            if (!contextIds.TryGetValue(key, out var id))
            {
                id = context.Count;
                contextIds.Add(key, id);
                context.Add(value);
            }
            return id;
        }

        string Description(CandidateElement item) =>
            peers.TryGetValue((item.Frame?.Id, item.Id), out var children)
                ? children
                    .Select(child => string.IsNullOrEmpty(child.Text) ? child.Label : child.Text)
                    .FirstOrDefault(name => !string.IsNullOrEmpty(name))
                    ?? item.Text
                : item.Text;
    }

    private static Dictionary<string, string[]>? Neighbors(CandidateElement origin, CandidateElement[] peers)
    {
        // ponytail: quadratic peer scans; index intervals if preparation becomes a measured bottleneck.
        var nearest = new Dictionary<string, (double Gap, List<string> Ids)>(StringComparer.Ordinal);
        var a = origin.Geometry;
        foreach (var peer in peers)
        {
            if (peer.Id == origin.Id)
            {
                continue;
            }
            var b = peer.Geometry;
            if (Math.Min(a.X + a.Width, b.X + b.Width) > Math.Max(a.X, b.X))
            {
                Add("below", b.Y - (a.Y + a.Height), peer.Id);
                Add("above", a.Y - (b.Y + b.Height), peer.Id);
            }
            if (Math.Min(a.Y + a.Height, b.Y + b.Height) > Math.Max(a.Y, b.Y))
            {
                Add("right", b.X - (a.X + a.Width), peer.Id);
                Add("left", a.X - (b.X + b.Width), peer.Id);
            }
        }
        return nearest.Count == 0 ? null : nearest.ToDictionary(pair => pair.Key, pair => pair.Value.Ids.ToArray());

        void Add(string direction, double gap, string id)
        {
            if (gap < 0)
            {
                return;
            }
            if (!nearest.TryGetValue(direction, out var current) || gap < current.Gap)
            {
                nearest[direction] = (gap, [id]);
            }
            else if (gap == current.Gap)
            {
                current.Ids.Add(id);
            }
        }
    }
}
