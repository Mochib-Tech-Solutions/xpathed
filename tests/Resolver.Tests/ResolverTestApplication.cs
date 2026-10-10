using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Xpathed.Resolver.Controllers;

namespace Xpathed.Resolver.Tests;

internal static class ResolverTestApplication
{
    internal static WebApplicationFactory<HealthController> CreateApplication(
        DeterministicServicesHandler handler,
        Dictionary<string, string?>? settings = null,
        ILoggerProvider? logs = null
    ) =>
        new WebApplicationFactory<HealthController>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration(
                (_, configuration) =>
                    configuration
                        .AddInMemoryCollection(
                            new Dictionary<string, string?>
                            {
                                ["OpenRouter:ApiKey"] = "test-token",
                                ["OpenRouter:Model"] = "deepseek/deepseek-v4.1-flash",
                                ["OpenRouter:Provider"] = "wafer",
                            }
                        )
                        .AddInMemoryCollection(settings ?? [])
            );
            builder.ConfigureServices(services =>
            {
                if (logs is not null)
                {
                    services.AddLogging(logging => logging.AddProvider(logs));
                }
                services.AddHttpClient("browser").ConfigurePrimaryHttpMessageHandler(() => handler);
                services.AddHttpClient("openrouter").ConfigurePrimaryHttpMessageHandler(() => handler);
            });
        });
}
