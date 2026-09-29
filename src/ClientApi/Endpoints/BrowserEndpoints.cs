using Xpathed.ClientApi.Http;

namespace Xpathed.ClientApi.Endpoints;

internal static class BrowserEndpoints
{
    public static void MapBrowserEndpoints(this WebApplication app)
    {
        var sessions = app.MapGroup("/api/sessions");
        sessions.MapPost("/", (HttpContext context, IHttpClientFactory clients) =>
            HttpForwarder.ForwardAsync(context, clients.CreateClient("browser"), "/sessions"));
        sessions.MapDelete("/{id}", (string id, HttpContext context, IHttpClientFactory clients) =>
            HttpForwarder.ForwardAsync(context, clients.CreateClient("browser"), $"/sessions/{Uri.EscapeDataString(id)}"));

        var pages = app.MapGroup("/api/pages");
        pages.MapGet("/{id}", (string id, HttpContext context, IHttpClientFactory clients) =>
            HttpForwarder.ForwardAsync(context, clients.CreateClient("browser"), $"/pages/{Uri.EscapeDataString(id)}"));
        pages.MapPost("/{id}/navigate", (string id, HttpContext context, IHttpClientFactory clients) =>
            HttpForwarder.ForwardAsync(context, clients.CreateClient("browser"), $"/pages/{Uri.EscapeDataString(id)}/navigate"));
        pages.MapPost("/{id}/inspect", (string id, HttpContext context, IHttpClientFactory clients) =>
            HttpForwarder.ForwardAsync(context, clients.CreateClient("resolver"), $"/pages/{Uri.EscapeDataString(id)}/inspect"));
    }
}
