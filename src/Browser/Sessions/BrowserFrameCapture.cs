using System.Text.Json;
using Microsoft.Playwright;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

internal sealed class BrowserFrameCapture(IFrame frame, IJSHandle handle, TargetFrame identity, BrowserFrameCapture? parent, IElementHandle? owner)
{
    public IFrame Frame { get; } = frame;
    public IJSHandle Handle { get; } = handle;
    public TargetFrame Identity { get; } = identity;
    public BrowserFrameCapture? Parent { get; } = parent;
    public IElementHandle? Owner { get; } = owner;
    public HashSet<string> CandidateIds { get; } = new(StringComparer.Ordinal);
    public ICDPSession? Highlight { get; set; }
    public int? ContextId { get; set; }

    public async Task RefreshAsync(int budgetMs)
    {
        if (Parent is null)
        {
            await Handle.EvaluateAsync("(capture, budgetMs) => capture.updateEnvironment(null, budgetMs)", budgetMs);
        }
        else
        {
            var info = await Parent.Handle.EvaluateAsync<JsonElement>("(capture, args) => capture.frameInfo(args.owner, args.budgetMs)", new { owner = Owner, budgetMs });
            if (info.TryGetProperty("errorCode", out _))
            {
                throw new ApiException(409, "validation_budget_exceeded", "Frame observation exceeded its processing budget.");
            }
            if (!info.GetProperty("environment").GetProperty("exposed").GetBoolean() ||
                !info.GetProperty("environment").GetProperty("geometrySupported").GetBoolean() || info.GetProperty("xpath").GetString() != Identity.Chain[^1].Xpath)
            {
                throw new ApiException(409, "stale_capture", "An ancestor frame changed after capture.");
            }
            await Handle.EvaluateAsync("(capture, args) => capture.updateEnvironment(args.environment, args.budgetMs)", new { environment = info.GetProperty("environment").GetRawText(), budgetMs });
        }
    }
}
