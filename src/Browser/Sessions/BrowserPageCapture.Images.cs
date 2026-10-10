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
    public async Task RequireImageCurrentAsync()
    {
        if (!complete)
        {
            throw new ApiException(409, "capture_incomplete", "The capture is incomplete.");
        }
        try
        {
            foreach (var frame in frames)
            {
                string? environment = null;
                if (frame.Parent is not null)
                {
                    var info = await frame.Parent.Handle.EvaluateAsync<JsonElement>(
                        "(capture, owner) => capture.frameInfo(owner)",
                        frame.Owner
                    );
                    ThrowScriptError(info);
                    if (
                        !info.GetProperty("environment").GetProperty("geometrySupported").GetBoolean()
                        || !info.GetProperty("environment").GetProperty("exposed").GetBoolean()
                    )
                    {
                        throw new ApiException(409, "stale_capture", "An ancestor frame changed after capture.");
                    }
                    environment = info.GetProperty("environment").GetRawText();
                }
                if (
                    frame.Frame.IsDetached
                    || !await frame.Handle.EvaluateAsync<bool>(
                        "(capture, environment) => capture.imageUnchanged(environment)",
                        environment
                    )
                )
                {
                    throw new ApiException(409, "stale_capture", "The captured view changed before image export.");
                }
            }
            if (!await PrivacyUnchangedAsync())
            {
                throw new ApiException(409, "stale_capture", "Private content changed after capture.");
            }
        }
        catch (CdpException)
        {
            throw new ApiException(409, "stale_capture", "The captured view is no longer available for image export.");
        }
    }

    public async Task<CaptureImage> CaptureImageAsync()
    {
        try
        {
            var png = await CdpScreenshot.CaptureAsync(
                page.Page,
                frames.ToDictionary(frame => frame.Frame, frame => frame.Handle)
            );
            return new CaptureImage(
                png,
                BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(16, 4)),
                BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(20, 4))
            );
        }
        catch (CdpException)
        {
            throw new ApiException(
                409,
                "capture_image_unavailable",
                "The browser could not safely mask this screenshot. Closed or inaccessible page components may prevent image export; try without a screenshot."
            );
        }
    }

    public async Task<bool> PrivacyUnchangedAsync()
    {
        try
        {
            foreach (var frame in frames)
            {
                if (
                    frame.Frame.IsDetached
                    || !await frame.Handle.EvaluateAsync<bool>("capture => capture.privacyUnchanged()")
                )
                {
                    return false;
                }
            }
            return true;
        }
        catch (CdpException)
        {
            return false;
        }
    }
}
