using System.Net.Sockets;
using Microsoft.AspNetCore.Mvc;
using Xpathed.Browser.Sessions;
using Xpathed.Browser.Viewing;
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

        var session = sessions.FindSession(id);
        using var tcp = new TcpClient();
        await tcp.ConnectAsync("127.0.0.1", session.Port, cancellationToken);
        using var socket = await HttpContext.WebSockets.AcceptWebSocketAsync();
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, session.Stop.Token);
        await VncRelay.RelayAsync(socket, tcp.GetStream(), lifetime.Token);
    }
}
