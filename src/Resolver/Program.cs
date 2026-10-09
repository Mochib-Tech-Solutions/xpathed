using Xpathed.Common.Http;
using Xpathed.Resolver.Middleware;
using Xpathed.Resolver.Services;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddApiControllers();
builder.Services.AddApiRateLimits(builder.Configuration);
builder.Services.AddHttpClient(
    "browser",
    client => client.BaseAddress = new Uri(builder.Configuration["BrowserUrl"] ?? "http://browser:8080")
);
builder.Services.AddHttpClient("openrouter");
builder.Services.AddMemoryCache();
builder.Services.AddTransient<OpenRouterGateway>();
builder.Services.AddTransient<ResolutionService>();
builder.Services.AddTransient<XPathSelectionService>();
builder.Services.AddSingleton<ProviderAccounting>();
builder.Services.AddSingleton<ImageRoutingCache>();
builder.Services.AddSingleton<ModelUsageLimits>();
var app = builder.Build();
_ = app.Services.GetRequiredService<ModelUsageLimits>();
app.UseApiErrors();
app.UseMiddleware<ServiceOriginMiddleware>();
app.UseRateLimiter();
app.MapControllers();
app.Run();
