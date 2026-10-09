using Microsoft.AspNetCore.Mvc;
using Xpathed.Browser.Sessions;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Controllers;

[ApiController]
[Route("view")]
public sealed class ViewerController(BrowserSessions sessions, IConfiguration configuration) : ControllerBase
{
    private readonly string[] allowedOrigins = (configuration["ViewerOrigins"] ?? "http://localhost:8080").Split(',');

    // WebSockets use GET with HTTP/1.1 and CONNECT with HTTP/2.
    [Route("{id}")]
    public async Task Connect(string id, CancellationToken cancellationToken)
    {
        if (!allowedOrigins.Contains(Request.Headers.Origin.ToString(), StringComparer.Ordinal))
        {
            throw new ApiException(403, "invalid_origin", "This viewer origin is not allowed.");
        }

        if (!HttpContext.WebSockets.IsWebSocketRequest)
        {
            throw new ApiException(400, "websocket_required", "A WebSocket connection is required.");
        }

        sessions.FindSession(id);
        using var socket = await HttpContext.WebSockets.AcceptWebSocketAsync();
        await sessions.ConnectViewerAsync(id, socket, cancellationToken);
    }
}
