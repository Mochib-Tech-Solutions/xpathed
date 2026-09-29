using System.Net.Sockets;
using Xpathed.Browser.Sessions;
using Xpathed.Browser.Viewing;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Endpoints;

internal static class ViewerEndpoints
{
    public static void MapViewerEndpoint(this WebApplication app)
    {
        var allowedOrigins = (app.Configuration["ViewerOrigins"] ?? "http://localhost:8080").Split(',');
        app.MapGet("/view/{id}", async (string id, BrowserSessions sessions, HttpContext context) =>
        {
            if (!allowedOrigins.Contains(context.Request.Headers.Origin.ToString(), StringComparer.Ordinal))
            {
                throw new ApiException(403, "invalid_origin", "This viewer origin is not allowed.");
            }

            if (!context.WebSockets.IsWebSocketRequest)
            {
                throw new ApiException(400, "websocket_required", "A WebSocket connection is required.");
            }

            var session = sessions.Find(id);
            using var tcp = new TcpClient();
            await tcp.ConnectAsync("127.0.0.1", session.Port, context.RequestAborted);
            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, session.Stop.Token);
            await VncRelay.RelayAsync(socket, tcp.GetStream(), lifetime.Token);
        });
    }
}
