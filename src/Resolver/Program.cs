using Xpathed.Common.Http;
using Xpathed.Resolver.Endpoints;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddHttpClient("browser", client =>
    client.BaseAddress = new Uri(builder.Configuration["BrowserUrl"] ?? "http://browser:8080"));
var app = builder.Build();
app.UseApiErrors();
app.Use(async (context, next) =>
{
    if (context.Request.Headers.ContainsKey("Origin"))
    {
        throw new ApiException(403, "invalid_origin", "Resolver requests must come from the client API or a service client.");
    }

    await next(context);
});
app.MapGet("/health", () => Results.Ok(new { service = "resolver" }));
app.MapInspectionEndpoints();
app.Run();
