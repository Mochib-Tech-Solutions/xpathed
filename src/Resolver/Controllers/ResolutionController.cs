using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Xpathed.Common.Contracts;
using Xpathed.Resolver.Services;

namespace Xpathed.Resolver.Controllers;

[ApiController]
[Route("pages")]
public sealed class ResolutionController(ResolutionService resolution) : ControllerBase
{
    [HttpPost("{pageId}/resolve")]
    public Task<ResolutionResult> Resolve(
        string pageId,
        ResolutionRequest request,
        CancellationToken cancellationToken
    ) =>
        resolution.ResolveAsync(
            pageId,
            request,
            Activity.Current?.TraceId.ToString() ?? HttpContext.TraceIdentifier,
            cancellationToken
        );
}
