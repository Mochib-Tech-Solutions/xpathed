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

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id)
    {
        await sessions.CloseAsync(id);
        return NoContent();
    }
}
