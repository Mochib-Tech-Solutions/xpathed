using Microsoft.EntityFrameworkCore;
using Xpathed.ClientApi.Data;
using Xpathed.ClientApi.Diagnostics;
using Xpathed.ClientApi.Middleware;
using Xpathed.Common.Http;

var operatorCommand = args is ["diagnostics", ..];
var builder = WebApplication.CreateBuilder(operatorCommand ? [] : args);
if (operatorCommand)
{
    builder.Logging.ClearProviders();
}
foreach (var setting in new[] { "Diagnostics:RecordRetentionDays", "Diagnostics:CaptureRetentionDays" })
{
    if (builder.Configuration.GetValue<int?>(setting) is < 1 or > 3650)
    {
        throw new InvalidOperationException($"{setting} must be between 1 and 3650 days.");
    }
}
builder.Services.AddApiControllers();
builder.Configuration["AllowedHosts"] = "localhost;127.0.0.1;client-api;web";
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Database"))
);
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddScoped<DiagnosticStore>();
builder.Services.AddScoped<ResolutionRecorder>();
builder.Services.AddHostedService<DiagnosticRetentionService>();
foreach (var service in new[] { "browser", "resolver" })
{
    builder.Services.AddHttpClient(
        service,
        client =>
        {
            client.BaseAddress = new Uri(builder.Configuration[$"{service}Url"] ?? $"http://{service}:8080");
            client.Timeout = TimeSpan.FromSeconds(45);
        }
    );
}

var app = builder.Build();
if (operatorCommand)
{
    await using var scope = app.Services.CreateAsyncScope();
    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
    Environment.ExitCode = await DiagnosticCommand.RunAsync(
        scope.ServiceProvider.GetRequiredService<DiagnosticStore>(),
        args[1..],
        deadline.Token
    );
    return;
}
if (app.Configuration.GetValue<bool>("Diagnostics:MigrateOnStartup"))
{
    using var scope = app.Services.CreateScope();
    await scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.MigrateAsync();
}
app.UseApiErrors();
app.UseMiddleware<SameOriginMiddleware>();
app.MapControllers();
app.Run();
