using Xpathed.Browser.Sessions;
using Xpathed.Common.Contracts;

namespace Xpathed.Browser.Endpoints;

internal static class BrowserEndpoints
{
    public static void MapBrowserEndpoints(this WebApplication app)
    {
        var sessions = app.MapGroup("/sessions");
        sessions.MapPost("/", (BrowserSessions browser, CancellationToken token) => browser.CreateAsync(token));
        sessions.MapDelete("/{id}", async (string id, BrowserSessions browser) =>
        {
            await browser.CloseAsync(id);
            return Results.NoContent();
        });

        var pages = app.MapGroup("/pages");
        pages.MapGet("/{id}", (string id, BrowserSessions browser, CancellationToken token) => browser.StateAsync(id, token));
        pages.MapPost("/{id}/navigate", (string id, NavigateRequest request, BrowserSessions browser, CancellationToken token) =>
            browser.NavigateAsync(id, request.Url ?? "", token));
        pages.MapGet("/{id}/inspection", (string id, BrowserSessions browser, CancellationToken token) => browser.InspectAsync(id, token));
    }
}
