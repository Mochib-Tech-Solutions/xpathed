using Xpathed.Browser.Endpoints;
using Xpathed.Browser.Sessions;
using Xpathed.Common.Http;

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
app.MapGet("/health", () => Results.Ok(new { service = "browser" }));
app.MapBrowserEndpoints();
app.MapViewerEndpoint();

var sessions = app.Services.GetRequiredService<BrowserSessions>();
var reaper = sessions.ReapAsync(app.Lifetime.ApplicationStopping);
await app.RunAsync();
try
{
    await reaper;
}
catch (OperationCanceledException) { }
