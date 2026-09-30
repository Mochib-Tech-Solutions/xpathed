using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Xpathed.ClientApi.Controllers;

namespace Xpathed.ClientApi.IntegrationTests;

public sealed class PersistenceFixture : IAsyncLifetime
{
    private readonly string databaseName = "diagnostics_test_" + Guid.NewGuid().ToString("N");
    private string adminConnection = "";
    public string ConnectionString { get; private set; } = "";

    public async Task InitializeAsync()
    {
        adminConnection =
            Environment.GetEnvironmentVariable("ConnectionStrings__Database")
            ?? throw new InvalidOperationException(
                "Set ConnectionStrings__Database to a disposable PostgreSQL server."
            );
        await using var connection = new NpgsqlConnection(adminConnection);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand($"CREATE DATABASE {databaseName}", connection);
        await command.ExecuteNonQueryAsync();
        ConnectionString = new NpgsqlConnectionStringBuilder(adminConnection)
        {
            Database = databaseName,
        }.ConnectionString;
    }

    public WebApplicationFactory<HealthController> Create(
        ResolverHandler handler,
        TimeProvider? clock = null,
        string? connection = null,
        bool migrate = true
    ) =>
        new WebApplicationFactory<HealthController>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration(
                (_, configuration) =>
                    configuration.AddInMemoryCollection(
                        new Dictionary<string, string?>
                        {
                            ["ConnectionStrings:Database"] = connection ?? ConnectionString,
                            ["Diagnostics:MigrateOnStartup"] = migrate.ToString(),
                        }
                    )
            );
            builder.ConfigureServices(services =>
            {
                services.AddHttpClient("resolver").ConfigurePrimaryHttpMessageHandler(() => handler);
                if (clock is not null)
                {
                    services.AddSingleton(clock);
                }
            });
        });

    public async Task DisposeAsync()
    {
        NpgsqlConnection.ClearAllPools();
        await using var connection = new NpgsqlConnection(adminConnection);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand($"DROP DATABASE {databaseName} WITH (FORCE)", connection);
        await command.ExecuteNonQueryAsync();
    }
}
