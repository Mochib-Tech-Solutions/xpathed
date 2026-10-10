using System.Text.Json;
using Xpathed.Browser.Scripts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Protocol;

internal static class CdpScreenshot
{
    public static async Task<byte[]> CaptureAsync(CdpPage page, IReadOnlyDictionary<CdpFrame, CdpRemoteObject> captures)
    {
        var frames = page.Frames;
        if (frames.Any(frame => frame.Context is null || frame.Context.SessionId != frame.SessionId))
        {
            throw new CdpException("A page frame is not ready for screenshot capture.");
        }
        var prepared = new List<CdpRemoteObject>();
        page.SuspendScreencastFrames();
        try
        {
            await RejectClosedAuthorRootsAsync(page);
            foreach (var frame in frames)
            {
                prepared.Add(
                    captures.TryGetValue(frame, out var capture)
                        ? await capture.EvaluateHandleAsync($"capture => ({BrowserScripts.PrepareScreenshot})(capture)")
                        : await frame.EvaluateHandleAsync(BrowserScripts.PrepareScreenshot, waitForContext: false)
                );
            }
            var screenshot = await page.SendAsync(
                "Page.captureScreenshot",
                new
                {
                    format = "png",
                    fromSurface = true,
                    captureBeyondViewport = false,
                }
            );
            if (!frames.ToHashSet().SetEquals(page.Frames))
            {
                throw new ApiException(409, "stale_capture", "The page frames changed during screenshot capture.");
            }
            await RejectClosedAuthorRootsAsync(page, afterCapture: true);
            foreach (var mask in prepared)
            {
                if (!await mask.EvaluateAsync<bool>("mask => mask.unchanged()"))
                {
                    throw new ApiException(409, "stale_capture", "Private controls changed during screenshot capture.");
                }
            }
            return Convert.FromBase64String(screenshot.GetProperty("data").GetString()!);
        }
        finally
        {
            try
            {
                foreach (var mask in prepared)
                {
                    try
                    {
                        await mask.EvaluateAsync("mask => mask.clear()");
                    }
                    catch (CdpException) { }
                    finally
                    {
                        await mask.DisposeAsync();
                    }
                }
            }
            finally
            {
                await page.ResumeScreencastFramesAsync();
            }
        }
    }

    private static async Task RejectClosedAuthorRootsAsync(CdpPage page, bool afterCapture = false)
    {
        foreach (var sessionId in page.Frames.Select(frame => frame.SessionId).Distinct(StringComparer.Ordinal))
        {
            var tree = await page.Connection.SendAsync(
                "DOMSnapshot.captureSnapshot",
                new { computedStyles = Array.Empty<string>() },
                sessionId
            );
            if (HasClosedAuthorRoot(tree))
            {
                if (afterCapture)
                {
                    throw new ApiException(
                        409,
                        "stale_capture",
                        "Private page components changed during screenshot capture."
                    );
                }
                throw new CdpException("Closed page components cannot be safely masked for image export.");
            }
        }
    }

    private static bool HasClosedAuthorRoot(JsonElement snapshot)
    {
        var strings = snapshot.GetProperty("strings");
        foreach (var document in snapshot.GetProperty("documents").EnumerateArray())
        {
            if (!document.GetProperty("nodes").TryGetProperty("shadowRootType", out var roots))
            {
                continue;
            }
            foreach (var value in roots.GetProperty("value").EnumerateArray())
            {
                if (strings[value.GetInt32()].GetString() == "closed")
                {
                    return true;
                }
            }
        }
        return false;
    }
}
