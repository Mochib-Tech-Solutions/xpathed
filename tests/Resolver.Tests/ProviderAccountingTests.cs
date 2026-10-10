using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Xpathed.Common.Contracts;
using Xpathed.Resolver.Services;
using static Xpathed.Resolver.Tests.DeterministicServicesHandler;
using static Xpathed.Resolver.Tests.ResolverTestApplication;

namespace Xpathed.Resolver.Tests;

public sealed class ProviderAccountingTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DisconnectedProviderChargesAreLoggedOnceWithoutLateSelection(bool duringValidation)
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var logs = new AccountingLogProvider();
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = BilledSelection(),
            BeforeRespondAsync = async (path, token) =>
            {
                if (path.EndsWith(duringValidation ? "/selections" : "/chat/completions", StringComparison.Ordinal))
                {
                    started.TrySetResult();
                    await release.Task.WaitAsync(token);
                }
            },
        };
        await using var application = CreateApplication(handler, logs: logs);
        using var client = application.CreateClient();
        using var cancellation = new CancellationTokenSource();
        var request = client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                imageMode = "text_only",
            },
            cancellation.Token
        );
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await request);
        Assert.Equal(0, handler.SelectionRequestCount);
        release.SetResult();
        await logs.Recorded.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var entry = Assert.Single(logs.Entries).ToDictionary(pair => pair.Key, pair => pair.Value);
        Assert.Equal(0.0000215m, entry["ReportedUsd"]);
        Assert.Equal("generation-1", entry["GenerationId"]);
        Assert.Equal("completed", entry["AccountingStatus"]);
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal(0, handler.SelectionRequestCount);
    }

    [Theory]
    [InlineData("/pages/page-1/selections")]
    public async Task CurrentViewTransportTimeoutRetainsChargesAlreadyReported(string slowPath)
    {
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = BilledSelection(),
            BeforeRespondAsync = (path, _) =>
            {
                if (path == slowPath)
                {
                    throw new TaskCanceledException("Controlled browser transport timeout");
                }
                return Task.CompletedTask;
            },
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("browser_timeout", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(
            0.0000215m,
            result.GetProperty("diagnostics").GetProperty("usage").GetProperty("cost").GetDecimal()
        );
        Assert.Equal("completed", result.GetProperty("diagnostics").GetProperty("providerAccounting").GetString());
        Assert.Empty(result.GetProperty("actions").EnumerateArray());
    }

    [Theory]
    [InlineData("API_KEY=violet-cactus-782", "[redacted]")]
    [InlineData("Bearer violet-cactus-782", "[redacted]")]
    [InlineData(
        "https://alice:violet-cactus-782@example.org/settings?auth=violet-cactus-782#violet-cactus-782",
        "https://example.org/settings"
    )]
    public async Task LateAccountingSanitizesCredentialBearingProviderMetadata(string metadata, string expected)
    {
        var logs = new AccountingLogProvider();
        await using var application = CreateApplication(new DeterministicServicesHandler(), logs: logs);
        var accounting = application.Services.GetRequiredService<ProviderAccounting>();
        accounting.Record(
            new ResolutionDiagnostics
            {
                GenerationId = metadata,
                Model = metadata,
                Provider = metadata,
            },
            "trace-1",
            "attempt-1",
            "configuration-1"
        );
        var entry = Assert.Single(logs.Entries).ToDictionary(pair => pair.Key, pair => pair.Value);
        Assert.Equal(expected, entry["GenerationId"]);
        Assert.Equal(expected, entry["Model"]);
        Assert.Equal(expected, entry["Provider"]);
        Assert.DoesNotContain("violet-cactus-782", JsonSerializer.Serialize(entry), StringComparison.Ordinal);
    }
}
