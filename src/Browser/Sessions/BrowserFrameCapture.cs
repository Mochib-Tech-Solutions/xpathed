using System.Text.Json;
using Microsoft.Playwright;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

internal sealed class BrowserFrameCapture(
    IFrame frame,
    IJSHandle handle,
    TargetFrame identity,
    BrowserFrameCapture? parent,
    IElementHandle? owner
)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public IFrame Frame { get; } = frame;
    public IJSHandle Handle { get; } = handle;
    public TargetFrame Identity { get; } = identity;
    public BrowserFrameCapture? Parent { get; } = parent;
    public IElementHandle? Owner { get; } = owner;
    public HashSet<string> CandidateIds { get; } = new(StringComparer.Ordinal);
    public IJSHandle? Highlight { get; set; }
    public string[] HighlightCandidateIds { get; set; } = [];

    public async Task<int> RefreshAsync(int budgetMs, int scanBudget)
    {
        var timer = System.Diagnostics.Stopwatch.StartNew();
        string? environment = null;
        if (Parent is not null)
        {
            var info = await Parent.Handle.EvaluateAsync<JsonElement>(
                "(capture, args) => capture.frameInfo(args.owner, args.budgetMs)",
                new { owner = Owner, budgetMs }
            );
            if (info.TryGetProperty("errorCode", out _))
            {
                throw new ApiException(
                    409,
                    "validation_budget_exceeded",
                    "Frame observation exceeded its processing budget."
                );
            }
            if (
                !info.GetProperty("environment").GetProperty("exposed").GetBoolean()
                || !info.GetProperty("environment").GetProperty("geometrySupported").GetBoolean()
                || info.GetProperty("xpath").GetString() != Identity.Chain[^1].Xpath
                || !SameShadowChain(info, Identity.Chain[^1].ShadowChain)
            )
            {
                throw new ApiException(409, "stale_capture", "An ancestor frame changed after capture.");
            }
            environment = info.GetProperty("environment").GetRawText();
        }
        var updated = await Handle.EvaluateAsync<JsonElement>(
            "(capture, args) => capture.updateEnvironment(args.environment, args.budgetMs, args.scanBudget)",
            new
            {
                environment,
                budgetMs = Math.Max(0, budgetMs - timer.ElapsedMilliseconds),
                scanBudget,
            }
        );
        if (updated.TryGetProperty("errorCode", out var error))
        {
            var stale = error.GetString() == "stale_capture";
            throw new ApiException(
                409,
                stale ? "stale_capture" : "validation_budget_exceeded",
                stale
                    ? "The current view changed after capture."
                    : "Viewport observation exceeded its processing budget."
            );
        }
        return updated.GetProperty("scannedCount").GetInt32();
    }

    private static bool SameShadowChain(JsonElement info, ShadowHost[]? expected)
    {
        var actual = info.TryGetProperty("shadowChain", out var chain)
            ? chain.Deserialize<ShadowHost[]>(JsonOptions)
            : null;
        return (actual ?? []).SequenceEqual(expected ?? []);
    }
}
