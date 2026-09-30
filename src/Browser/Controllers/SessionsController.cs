using Microsoft.AspNetCore.Mvc;
using Xpathed.Browser.Sessions;
using Xpathed.Common.Contracts;

namespace Xpathed.Browser.Controllers;

[ApiController]
[Route("sessions")]
public sealed class SessionsController(BrowserSessions sessions) : ControllerBase
{
    [HttpPost]
    public Task<BrowserSession> Create(CancellationToken cancellationToken) => sessions.CreateAsync(cancellationToken);

    [HttpGet("{id}")]
    public Task<BrowserSessionState> Get(string id, CancellationToken cancellationToken) => sessions.SessionStateAsync(id, cancellationToken);

    [HttpPost("{id}/pages")]
    public Task<BrowserSessionState> NewPage(string id, CancellationToken cancellationToken) => sessions.NewPageAsync(id, cancellationToken);

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id)
    {
        await sessions.CloseAsync(id);
        return NoContent();
    }
}
