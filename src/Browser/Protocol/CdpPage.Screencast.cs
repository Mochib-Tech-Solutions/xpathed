using System.Collections.Concurrent;
using System.Text.Json;
using Xpathed.Browser.Scripts;
using Xpathed.Common.Contracts;

namespace Xpathed.Browser.Protocol;

internal sealed partial class CdpPage
{
    private void BeginFrameGeneration()
    {
        var generation = Interlocked.Increment(ref documentGeneration);
        Volatile.Write(ref minimumFrameTimestamp, double.PositiveInfinity);
        _ = RefreshFrameGenerationAsync(generation);
    }

    private async Task RefreshFrameGenerationAsync(long generation)
    {
        try
        {
            var timestamp = await EvaluateAsync<double>(
                "() => new Promise(resolve => requestAnimationFrame(() => resolve((performance.timeOrigin + performance.now()) / 1000)))"
            );
            if (generation != Interlocked.Read(ref documentGeneration) || IsClosed)
            {
                return;
            }
            Volatile.Write(ref minimumFrameTimestamp, timestamp);
            if (screencastRequested)
            {
                await SendAsync("Page.stopScreencast");
                await StartScreencastAsync();
            }
        }
        catch (CdpException) { }
        catch (OperationCanceledException) { }
    }

    private async Task AcknowledgeFrameAsync(string id, int frameId)
    {
        try
        {
            await Connection.SendAsync("Page.screencastFrameAck", new { sessionId = frameId }, id);
        }
        catch (CdpException) { }
        catch (OperationCanceledException) { }
    }

    public async Task StartScreencastAsync()
    {
        screencastRequested = true;
        if (double.IsPositiveInfinity(Volatile.Read(ref minimumFrameTimestamp)))
        {
            return;
        }
        await SendAsync(
            "Page.startScreencast",
            new
            {
                format = "jpeg",
                quality = 80,
                maxWidth = Resolution.Width,
                maxHeight = Resolution.Height,
                everyNthFrame = 1,
            }
        );
    }

    public Task StopScreencastAsync()
    {
        screencastRequested = false;
        return SendAsync("Page.stopScreencast");
    }
}
