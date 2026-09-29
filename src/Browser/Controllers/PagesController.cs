using Microsoft.AspNetCore.Mvc;
using Xpathed.Browser.Sessions;
using Xpathed.Common.Contracts;

namespace Xpathed.Browser.Controllers;

[ApiController]
[Route("pages")]
public sealed class PagesController(BrowserSessions sessions) : ControllerBase
{
    [HttpGet("{id}")]
    public Task<PageState> Get(string id, CancellationToken cancellationToken) => sessions.StateAsync(id, cancellationToken);

    [HttpPost("{id}/navigate")]
    public Task<PageState> Navigate(string id, [FromBody] NavigateRequest request, CancellationToken cancellationToken) =>
        sessions.NavigateAsync(id, request.Url ?? "", cancellationToken);

    [HttpGet("{id}/inspection")]
    public Task<PageInspection> Inspect(string id, CancellationToken cancellationToken) => sessions.InspectAsync(id, cancellationToken);
}
