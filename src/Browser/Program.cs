using Xpathed.Browser.Middleware;
using Xpathed.Browser.Sessions;
using Xpathed.Common.Http;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddApiControllers();
builder.Services.AddSingleton<BrowserSessions>();
builder.Services.AddHostedService<BrowserSessionReaper>();
var app = builder.Build();
app.UseApiErrors();
app.UseMiddleware<BrowserOriginMiddleware>();
app.UseWebSockets();
app.MapControllers();
await app.RunAsync();
