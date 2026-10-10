using System.Buffers.Binary;
using System.Diagnostics;
using System.Text.Json;
using Xpathed.Browser.Protocol;
using Xpathed.Browser.Scripts;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

internal sealed partial class BrowserPageCapture(BrowserPageRuntime page) : IAsyncDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly List<BrowserFrameCapture> frames = [];
    private bool complete;
    private string? xpathEvidenceId;
    private readonly HashSet<BrowserFrameCapture> selectedFrames = [];
    private readonly HashSet<BrowserFrameCapture> xpathFrames = [];

    public bool UsesFrame(CdpFrame frame) => selectedFrames.Any(captured => captured.Frame == frame);

    public async Task<CandidateCapture> CaptureAsync(string sessionId, string documentId, string captureId)
    {
        var candidates = new List<CandidateElement>();
        var scanned = 0;
        var eligible = 0;
        var excludedOffscreen = 0;
        var unsupported = 0;
        string? error = null;
        var environment = await page.Page.EvaluateAsync<JsonElement>(
            "() => ({x:0,y:0,scaleX:1,scaleY:1,exposed:true,rendered:true,clip:{left:0,top:0,right:innerWidth,bottom:innerHeight}})"
        );
        await VisitAsync(page.Page.MainFrame, new TargetFrame("main", documentId, []), null, null, environment);
        complete = error is null;
        return new CandidateCapture(
            sessionId,
            page.Id,
            documentId,
            captureId,
            "main",
            DateTimeOffset.UtcNow,
            complete ? [.. candidates] : [],
            new CaptureCoverage(scanned, eligible, complete ? candidates.Count : 0, complete, error, excludedOffscreen),
            unsupported,
            "current_view"
        );

        async Task VisitAsync(
            CdpFrame frame,
            TargetFrame identity,
            BrowserFrameCapture? parent,
            CdpRemoteObject? owner,
            JsonElement environment
        )
        {
            if (error is not null)
            {
                return;
            }
            var handle = await frame.EvaluateHandleAsync(
                BrowserScripts.Capture,
                new
                {
                    sessionId,
                    pageId = page.Id,
                    documentId,
                    captureId,
                    scope = "current_view",
                    frame = JsonSerializer.Serialize(identity, JsonOptions),
                    environment = environment.GetRawText(),
                }
            );
            var captured = new BrowserFrameCapture(frame, handle, identity, parent, owner);
            frames.Add(captured);
            var data = await handle.EvaluateAsync<string>("capture => JSON.stringify(capture.data)");
            var result = JsonSerializer.Deserialize<CandidateCapture>(data, JsonOptions)!;
            scanned += result.Coverage.ScannedCount;
            eligible += result.Coverage.EligibleCount;
            excludedOffscreen += result.Coverage.ExcludedOffscreenCount;
            unsupported += result.UnsupportedBoundaryCount;
            candidates.AddRange(result.Candidates);
            captured.CandidateIds.UnionWith(result.Candidates.Select(candidate => candidate.Id));
            if (!result.Coverage.Complete)
            {
                error = result.Coverage.ErrorCode ?? "capture_incomplete";
                return;
            }
            var childCount = await handle.EvaluateAsync<int>("capture => capture.frameElements.length");
            for (var index = 0; index < childCount && error is null; index++)
            {
                var childHandle = await handle.EvaluateHandleAsync(
                    "(capture, index) => capture.frameElements[index]",
                    index
                );
                var element = childHandle;
                var info = await handle.EvaluateAsync<JsonElement>(
                    "(capture, element) => capture.frameInfo(element)",
                    element
                );
                if (info.TryGetProperty("errorCode", out var helperError))
                {
                    error = helperError.GetString();
                    await childHandle.DisposeAsync();
                    break;
                }
                var child = await element.ContentFrameAsync();
                if (child is null || !info.GetProperty("environment").GetProperty("geometrySupported").GetBoolean())
                {
                    unsupported++;
                    await childHandle.DisposeAsync();
                    continue;
                }
                var id = $"f{frames.Count}";
                var chain = identity
                    .Chain.Append(
                        new FrameAncestor(
                            id,
                            info.GetProperty("xpath").GetString()!,
                            info.GetProperty("label").GetString()!,
                            info.TryGetProperty("shadowChain", out var shadowChain)
                                ? shadowChain.Deserialize<ShadowHost[]>(JsonOptions)
                                : null,
                            info.GetProperty("nodeId").GetString()
                        )
                    )
                    .ToArray();
                var before = frames.Count;
                try
                {
                    await VisitAsync(
                        child,
                        new TargetFrame(id, Guid.NewGuid().ToString("N"), chain),
                        captured,
                        element,
                        info.GetProperty("environment")
                    );
                }
                finally
                {
                    if (frames.Count == before)
                    {
                        await childHandle.DisposeAsync();
                    }
                }
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        await ClearHighlightAsync();
        foreach (var frame in frames)
        {
            try
            {
                await frame.Handle.EvaluateAsync("capture => capture.dispose()");
            }
            catch (CdpException) { }
            try
            {
                await frame.Handle.DisposeAsync();
                if (frame.Owner is not null)
                {
                    await frame.Owner.DisposeAsync();
                }
            }
            catch (CdpException) { }
        }
    }
}
