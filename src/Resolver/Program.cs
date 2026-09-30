using Xpathed.Common.Http;
using Xpathed.Resolver.Middleware;
using Xpathed.Resolver.Services;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddApiControllers();
builder.Services.AddHttpClient("browser", client =>
    client.BaseAddress = new Uri(builder.Configuration["BrowserUrl"] ?? "http://browser:8080"));
builder.Services.AddHttpClient("openrouter");
builder.Services.AddTransient<OpenRouterGateway>();
builder.Services.AddTransient<ResolutionService>();
var app = builder.Build();
app.UseApiErrors();
app.UseMiddleware<ServiceOriginMiddleware>();
app.MapControllers();
app.Run();
