using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;
using Xpathed.Resolver.Services;

namespace Xpathed.Resolver.Controllers;

[ApiController]
[Route("internal/pages")]
public sealed class DiagnosticResolutionController(ResolutionService resolution) : ControllerBase
{
    [HttpPost("{pageId}/resolve")]
    public Task<DiagnosticResolution> Resolve(
        string pageId,
        ResolutionRequest request,
        CancellationToken cancellationToken
    )
    {
        var supplied = Request.Headers["X-Xpathed-Attempt-Id"].ToString();
        if (!Guid.TryParseExact(supplied, "N", out var attemptId))
        {
            throw new ApiException(400, "invalid_request", "A diagnostic attempt identity is required.");
        }
        return resolution.ResolveWithEvidenceAsync(
            pageId,
            request,
            Activity.Current?.TraceId.ToString() ?? HttpContext.TraceIdentifier,
            attemptId.ToString("N"),
            cancellationToken
        );
    }
}
