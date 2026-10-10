using System.Collections.Concurrent;
using System.Net.WebSockets;
using Xpathed.Browser.Protocol;
using Xpathed.Browser.Viewing;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

public sealed partial class BrowserSessions
{
    public Task<CandidateCapture> CaptureAsync(string pageId, CaptureRequest request, CancellationToken token) =>
        OnPageAsync(
            pageId,
            async (s, page) =>
            {
                await RequireFocusedDocumentAsync(s, page, request.DocumentId);
                await page.ClearCaptureAsync();
                await page.BeginCaptureAsync();
                page.CaptureId = Guid.NewGuid().ToString("N");
                var captureId = page.CaptureId;
                page.Capture = new BrowserPageCapture(page);
                var result = await page.Capture.CaptureAsync(s.Id, request.DocumentId, captureId);
                if (request.IncludeImage)
                {
                    result = result with { Image = await page.Capture.CaptureImageAsync() };
                }
                await RequireFocusedDocumentAsync(s, page, request.DocumentId);
                if (page.CaptureId != captureId)
                {
                    throw new ApiException(409, "stale_capture", "This capture is no longer current.");
                }
                if (!await page.Capture.PrivacyUnchangedAsync())
                {
                    throw new ApiException(
                        409,
                        "stale_capture",
                        "Private content changed while the page was captured."
                    );
                }

                return result;
            },
            token
        );

    public Task<CaptureImageResult> CaptureImageAsync(
        string pageId,
        CaptureImageRequest request,
        CancellationToken token
    ) =>
        OnPageAsync(
            pageId,
            async (session, page) =>
            {
                await RequireCaptureAsync(session, page, request.DocumentId, request.CaptureId);
                var capture = page.Capture!;
                await capture.RequireImageCurrentAsync();
                CaptureImage image;
                try
                {
                    image = await capture.CaptureImageAsync();
                }
                catch (ApiException error) when (error.Code == "capture_image_unavailable")
                {
                    await RequireCurrentAsync();
                    throw;
                }
                await RequireCurrentAsync();
                return new CaptureImageResult(session.Id, page.Id, request.DocumentId, request.CaptureId, image);

                async Task RequireCurrentAsync()
                {
                    await RequireCaptureAsync(session, page, request.DocumentId, request.CaptureId);
                    await capture.RequireImageCurrentAsync();
                    RequireDocument(session, page, request.DocumentId);
                    if (page.Capture != capture || page.CaptureId != request.CaptureId)
                    {
                        throw new ApiException(409, "stale_capture", "This capture is no longer current.");
                    }
                }
            },
            token
        );

    public Task<XPathEvidenceBatch> XPathEvidenceAsync(
        string pageId,
        XPathEvidenceRequest request,
        CancellationToken token
    ) =>
        OnPageAsync(
            pageId,
            async (session, page) =>
            {
                await RequireCaptureAsync(session, page, request.DocumentId, request.CaptureId);
                page.ActionSelections = null;
                var evidence = await page.Capture!.XPathEvidenceAsync(request.CandidateIds);
                await RequireCaptureAsync(session, page, request.DocumentId, request.CaptureId);
                if (!await page.Capture.XPathPrivacyUnchangedAsync())
                {
                    throw new ApiException(
                        409,
                        "stale_capture",
                        "Private content changed while the page was observed."
                    );
                }
                return evidence;
            },
            token
        );

    private static async Task RequireCaptureAsync(
        BrowserSessionRuntime session,
        BrowserPageRuntime page,
        string documentId,
        string captureId
    )
    {
        await RequireFocusedDocumentAsync(session, page, documentId);
        if (page.Capture is null || page.CaptureId != captureId)
        {
            throw new ApiException(409, "stale_capture", "This capture is no longer current.");
        }
    }
}
