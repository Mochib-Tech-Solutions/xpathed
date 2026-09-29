using Microsoft.EntityFrameworkCore;
using Xpathed.ClientApi.Data;
using Xpathed.ClientApi.Middleware;
using Xpathed.Common.Http;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddApiControllers();
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
app.UseMiddleware<SameOriginMiddleware>();
app.MapControllers();
app.Run();
