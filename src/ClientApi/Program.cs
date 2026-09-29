using Microsoft.EntityFrameworkCore;
using Xpathed.ClientApi.Data;
using Xpathed.ClientApi.Endpoints;
using Xpathed.Common.Http;

var builder = WebApplication.CreateBuilder(args);
builder.Configuration["AllowedHosts"] = "localhost;127.0.0.1;client-api;web";
builder.Services.AddDbContext<AppDbContext>(options => options.UseNpgsql(builder.Configuration.GetConnectionString("Database")));
foreach (var service in new[] { "browser", "resolver" })
{
    builder.Services.AddHttpClient(service, client =>
    {
        client.BaseAddress = new Uri(builder.Configuration[$"{service}Url"] ?? $"http://{service}:8080");
        client.Timeout = TimeSpan.FromSeconds(45);
    });
}

var app = builder.Build();
app.UseApiErrors();
app.Use(async (context, next) =>
{
    if (context.Request.Headers.TryGetValue("Origin", out var origin) &&
        origin != $"{context.Request.Scheme}://{context.Request.Host}")
    {
        throw new ApiException(403, "invalid_origin", "This origin is not allowed.");
    }

    await next(context);
});
app.MapGet("/health", async (AppDbContext db, CancellationToken token) =>
    await db.Database.CanConnectAsync(token) ? Results.Ok(new { service = "client-api", database = "connected" }) : Results.StatusCode(503));
app.MapBrowserEndpoints();
app.Run();
