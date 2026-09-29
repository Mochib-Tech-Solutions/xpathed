using System.Net.Http.Json;
using Xpathed;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddHttpClient("browser", client =>
    client.BaseAddress = new Uri(builder.Configuration["BrowserUrl"] ?? "http://browser:8080"));
var app = builder.Build();
app.UseApiErrors();
app.Use(async (context, next) =>
{
    if (context.Request.Headers.ContainsKey("Origin"))
        throw new ApiException(403, "invalid_origin", "Resolver requests must come from the client API or a service client.");
    await next(context);
});
app.MapGet("/health", () => Results.Ok(new { service = "resolver" }));
app.MapPost("/pages/{pageId}/inspect", async (string pageId, HttpContext context, IHttpClientFactory clients) =>
{
    using var response = await clients.CreateClient("browser").GetAsync($"/pages/{Uri.EscapeDataString(pageId)}/inspection", context.RequestAborted);
    if (!response.IsSuccessStatusCode)
    {
        context.Response.StatusCode = (int)response.StatusCode;
        context.Response.ContentType = "application/json";
        await response.Content.CopyToAsync(context.Response.Body, context.RequestAborted);
        return;
    }
    var page = await response.Content.ReadFromJsonAsync<PageInspection>(context.RequestAborted);
    await context.Response.WriteAsJsonAsync(new InspectionResult("resolver", page!), context.RequestAborted);
});
app.Run();
