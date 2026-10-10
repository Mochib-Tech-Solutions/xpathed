using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Xpathed.Resolver.Controllers;
using static Xpathed.Resolver.Tests.DeterministicServicesHandler;

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

    internal static async Task<JsonElement> ResolveContextAsync(
        DeterministicServicesHandler handler,
        string instruction
    )
    {
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction,
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }
}
