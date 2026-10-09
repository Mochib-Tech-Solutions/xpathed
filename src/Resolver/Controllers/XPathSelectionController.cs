using Microsoft.AspNetCore.Mvc;
using Xpathed.Common.Contracts;
using Xpathed.Resolver.Services;

namespace Xpathed.Resolver.Controllers;

[ApiController]
[Route("pages")]
public sealed class XPathSelectionController(XPathSelectionService selection) : ControllerBase
{
    [HttpPost("{pageId}/selections")]
    public Task<ActionSelectionValidation> SelectActions(
        string pageId,
        ActionSelectionRequest request,
        CancellationToken cancellationToken
    ) => selection.SelectAsync(pageId, request, cancellationToken);

    [HttpPost("{pageId}/selection")]
    public async Task<SelectionValidation> Select(
        string pageId,
        SelectionRequest request,
        CancellationToken cancellationToken
    )
    {
        var result = await selection.SelectAsync(
            pageId,
            new ActionSelectionRequest(
                request.DocumentId,
                request.CaptureId,
                [new ActionSelection("single", request.CandidateId, request.Action)]
            ),
            cancellationToken
        );
        return new SelectionValidation(result.Actions[0].Target);
    }
}
