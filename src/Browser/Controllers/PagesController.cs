using Microsoft.AspNetCore.Mvc;
using Xpathed.Browser.Sessions;
using Xpathed.Common.Contracts;

namespace Xpathed.Browser.Controllers;

[ApiController]
[Route("pages")]
public sealed class PagesController(BrowserSessions sessions) : ControllerBase
{
    [HttpGet("{id}")]
    public Task<PageState> Get(string id, CancellationToken cancellationToken) =>
        sessions.StateAsync(id, cancellationToken);

    [HttpPost("{id}/activate")]
    public Task<BrowserSessionState> Activate(string id, CancellationToken cancellationToken) =>
        sessions.ActivateAsync(id, cancellationToken);

    [HttpDelete("{id}")]
    public Task<BrowserSessionState> Close(string id, CancellationToken cancellationToken) =>
        sessions.ClosePageAsync(id, cancellationToken);

    [HttpPost("{id}/navigate")]
    public Task<PageState> Navigate(
        string id,
        [FromBody] NavigateRequest request,
        CancellationToken cancellationToken
    ) => sessions.NavigateAsync(id, request.Url ?? "", cancellationToken);

    [HttpGet("{id}/inspection")]
    public Task<PageInspection> Inspect(string id, CancellationToken cancellationToken) =>
        sessions.InspectAsync(id, cancellationToken);

    [HttpPost("{id}/capture")]
    public Task<CandidateCapture> Capture(
        string id,
        [FromBody] CaptureRequest request,
        CancellationToken cancellationToken
    ) => sessions.CaptureAsync(id, request, cancellationToken);

    [HttpPost("{id}/selection")]
    public Task<SelectionValidation> Select(
        string id,
        [FromBody] SelectionRequest request,
        CancellationToken cancellationToken
    ) => sessions.SelectAsync(id, request, cancellationToken);

    [HttpPost("{id}/selections")]
    public Task<ActionSelectionValidation> SelectActions(
        string id,
        [FromBody] ActionSelectionRequest request,
        CancellationToken cancellationToken
    ) => sessions.SelectActionsAsync(id, request, cancellationToken);

    [HttpPost("{id}/highlight")]
    public Task<ValidatedAction> InspectAction(
        string id,
        [FromBody] InspectActionRequest request,
        CancellationToken cancellationToken
    ) => sessions.InspectActionAsync(id, request, cancellationToken);

    [HttpPost("{id}/execute")]
    public Task<ActionExecutionResult> ExecuteAction(
        string id,
        [FromBody] ExecuteActionRequest request,
        CancellationToken cancellationToken
    ) => sessions.ExecuteActionAsync(id, request, cancellationToken);

    [HttpPost("{id}/spotlight")]
    public async Task<IActionResult> Spotlight(
        string id,
        [FromBody] SpotlightRequest request,
        CancellationToken cancellationToken
    )
    {
        await sessions.SpotlightAsync(id, request, cancellationToken);
        return NoContent();
    }
}
