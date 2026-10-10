using System.Buffers.Binary;
using System.Diagnostics;
using System.Text.Json;
using Xpathed.Browser.Protocol;
using Xpathed.Browser.Scripts;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

internal sealed partial class BrowserPageCapture
{
    public async Task HighlightAsync(ResolvedTarget[] targets)
    {
        foreach (var frame in frames)
        {
            var ids = targets
                .Where(target => frame.CandidateIds.Contains(target.CandidateId))
                .Select(target => target.CandidateId)
                .Distinct()
                .ToArray();
            if (ids.Length == 0)
            {
                continue;
            }
            frame.Highlight = await frame.Handle.EvaluateHandleAsync(
                "(capture, ids) => (" + BrowserScripts.Highlight + ")(capture.highlightNodes(ids))",
                ids
            );
            frame.HighlightCandidateIds = ids;
        }
    }

    public async Task SpotlightAsync(string? candidateId)
    {
        foreach (var frame in frames)
        {
            if (frame.Highlight is { } highlight)
            {
                var index = candidateId is null ? -1 : Array.IndexOf(frame.HighlightCandidateIds, candidateId);
                await highlight.EvaluateAsync(
                    "(overlay, selection) => overlay.spotlight(selection.index, selection.active)",
                    new { index, active = candidateId is not null }
                );
            }
        }
    }

    public async Task ClearHighlightAsync()
    {
        foreach (var frame in frames.ToArray())
        {
            var highlight = frame.Highlight;
            frame.Highlight = null;
            frame.HighlightCandidateIds = [];
            if (highlight is null)
            {
                continue;
            }
            try
            {
                await highlight.EvaluateAsync("overlay => overlay.clear()");
                await highlight.DisposeAsync();
            }
            catch (CdpException) { }
        }
    }
}
