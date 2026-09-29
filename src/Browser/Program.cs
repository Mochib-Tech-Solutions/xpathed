using System.Net.Sockets;
using Xpathed;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<BrowserSessions>();
var app = builder.Build();
app.UseApiErrors();
app.Use(async (context, next) =>
{
    if ((context.Request.Path.StartsWithSegments("/sessions") || context.Request.Path.StartsWithSegments("/pages")) &&
        context.Request.Headers.ContainsKey("Origin"))
    {
        throw new ApiException(403, "invalid_origin", "Browser control is available through the client API.");
    }

    await next(context);
});
app.UseWebSockets();
app.UseStaticFiles();
app.MapGet("/health", () => Results.Ok(new { service = "browser" }));
app.MapPost("/sessions", (BrowserSessions sessions, CancellationToken token) => sessions.Create(token));
app.MapDelete("/sessions/{id}", async (string id, BrowserSessions sessions) =>
{
    await sessions.Close(id);
    return Results.NoContent();
});
app.MapGet("/pages/{id}", (string id, BrowserSessions sessions, CancellationToken token) =>
{
    return sessions.State(id, token);
});
app.MapPost("/pages/{id}/navigate", (string id, NavigateRequest request, BrowserSessions sessions, CancellationToken token) =>
    sessions.Navigate(id, request.Url ?? "", token));
app.MapGet("/pages/{id}/inspection", (string id, BrowserSessions sessions, CancellationToken token) => sessions.Inspect(id, token));
app.MapGet("/view/{id}", async (string id, BrowserSessions sessions, HttpContext context) =>
{
    var allowedOrigins = (builder.Configuration["ViewerOrigins"] ?? "http://localhost:8080").Split(',');
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
    await HttpBoundary.Relay(socket, tcp.GetStream(), lifetime.Token);
});
var sessions = app.Services.GetRequiredService<BrowserSessions>();
var reaper = sessions.Reap(app.Lifetime.ApplicationStopping);
await app.RunAsync();
try
{
    await reaper;
}
catch (OperationCanceledException) { }
