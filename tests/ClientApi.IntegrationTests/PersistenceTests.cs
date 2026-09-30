using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Xpathed.ClientApi.IntegrationTests;

public sealed class PersistenceTests(PersistenceFixture database) : IClassFixture<PersistenceFixture>
{
    [Fact]
    public async Task ResolutionIsAutomaticallyRecordedAndSurvivesApplicationRestart()
    {
        string attempt;
        await using (var application = database.Create(new ResolverHandler()))
        {
            using var client = application.CreateClient();
            using var response = await client.PostAsJsonAsync(
                "/api/pages/page-1/resolve",
                new
                {
                    instruction = "Click Save",
                    documentId = "document-1",
                    contractVersion = "2",
                }
            );
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var result = await response.Content.ReadFromJsonAsync<JsonElement>();
            attempt = result.GetProperty("attemptId").GetString()!;
            Assert.False(result.TryGetProperty("evidence", out _));
        }
        await using var restarted = database.Create(new ResolverHandler());
        using var reader = restarted.CreateClient();
        using var exported = await reader.GetAsync($"/internal/diagnostics/{attempt}");
        Assert.Equal(HttpStatusCode.OK, exported.StatusCode);
        var record = await exported.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("1", record.GetProperty("version").GetString());
        Assert.Equal("resolution", record.GetProperty("kind").GetString());
        Assert.Equal("not_found", record.GetProperty("result").GetProperty("outcome").GetString());
        Assert.Equal(
            0.0001m,
            record
                .GetProperty("result")
                .GetProperty("diagnostics")
                .GetProperty("usage")
                .GetProperty("cost")
                .GetDecimal()
        );
        Assert.Equal("available", record.GetProperty("evidenceAvailability").GetString());
        Assert.Equal("configuration-1", record.GetProperty("provenance").GetProperty("configurationId").GetString());
    }

    [Fact]
    public async Task UpstreamFailurePreservesKnownRequestAndExplicitMissingEvidence()
    {
        await using var app = database.Create(new ResolverHandler { Fail = true });
        using var client = app.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/api/pages/page-failure/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                contractVersion = "2",
            }
        );
        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        var records = await client.GetFromJsonAsync<JsonElement>("/internal/diagnostics?pageId=page-failure");
        var record = records.EnumerateArray().Single();
        Assert.Equal("error", record.GetProperty("outcome").GetString());
        Assert.Equal("Click Save", record.GetProperty("result").GetProperty("instruction").GetString());
        Assert.Equal("unavailable", record.GetProperty("evidenceAvailability").GetString());
        Assert.Equal(JsonValueKind.Null, record.GetProperty("evidence").ValueKind);
        Assert.DoesNotContain("private upstream detail", record.GetRawText(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task DatabaseOutageDoesNotChangeSuccessfulResolutionIntoSemanticFailure()
    {
        await using var app = database.Create(
            new ResolverHandler(),
            connection: "Host=127.0.0.1;Port=1;Database=missing;Username=missing;Password=synthetic;Timeout=1",
            migrate: false
        );
        using var client = app.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/api/pages/page-outage/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                contractVersion = "2",
            }
        );
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("not_found", result.GetProperty("outcome").GetString());
        using var health = await client.GetAsync("/health");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, health.StatusCode);
    }

    [Fact]
    public async Task ConcurrentRequestsRetainSeparateAttemptsAndPageIdentity()
    {
        await using var app = database.Create(new ResolverHandler());
        using var client = app.CreateClient();
        var ids = await Task.WhenAll(
            Enumerable
                .Range(0, 8)
                .Select(async index =>
                {
                    var page = $"concurrent-{index}";
                    using var response = await client.PostAsJsonAsync(
                        $"/api/pages/{page}/resolve",
                        new
                        {
                            instruction = "Click Save",
                            documentId = $"document-{index}",
                            contractVersion = "2",
                        }
                    );
                    response.EnsureSuccessStatusCode();
                    var result = await response.Content.ReadFromJsonAsync<JsonElement>();
                    var id = result.GetProperty("attemptId").GetString()!;
                    var record = await client.GetFromJsonAsync<JsonElement>($"/internal/diagnostics/{id}");
                    Assert.Equal(page, record.GetProperty("pageId").GetString());
                    Assert.Equal(
                        $"document-{index}",
                        record.GetProperty("result").GetProperty("documentId").GetString()
                    );
                    return id;
                })
        );
        Assert.Equal(8, ids.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public async Task InvalidUpstreamIdentityIsAnOperationalFailureWithEvidenceUnavailable()
    {
        await using var app = database.Create(new ResolverHandler { InvalidIdentity = true });
        using var client = app.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/api/pages/page-identity/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                contractVersion = "2",
            }
        );
        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        var records = await client.GetFromJsonAsync<JsonElement>("/internal/diagnostics?pageId=page-identity");
        var record = records.EnumerateArray().Single();
        Assert.Equal(
            "invalid_resolver_response",
            record.GetProperty("result").GetProperty("diagnostics").GetProperty("code").GetString()
        );
        Assert.Equal("unavailable", record.GetProperty("evidenceAvailability").GetString());
    }

    [Fact]
    public async Task CancellationStillRecordsKnownAttemptWithoutInventingProviderEvidence()
    {
        var handler = new ResolverHandler { Wait = true };
        await using var app = database.Create(handler);
        using var client = app.CreateClient();
        using var cancellation = new CancellationTokenSource();
        var call = client.PostAsJsonAsync(
            "/api/pages/page-cancelled/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                contractVersion = "2",
            },
            cancellation.Token
        );
        await handler.Started.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await cancellation.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => call);
        var records = await client.GetFromJsonAsync<JsonElement>("/internal/diagnostics?pageId=page-cancelled");
        var record = records.EnumerateArray().Single();
        Assert.Equal(
            "cancelled",
            record.GetProperty("result").GetProperty("diagnostics").GetProperty("code").GetString()
        );
        Assert.Equal("unavailable", record.GetProperty("evidenceAvailability").GetString());
    }

    [Theory]
    [InlineData("Fill password with violet-cactus-782")]
    [InlineData("Type violet-cactus-782 into Name")]
    public async Task StoredAttemptsDoNotRetainEnteredValues(string instruction)
    {
        await using var app = database.Create(new ResolverHandler());
        using var client = app.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/api/pages/page-private/resolve",
            new
            {
                instruction,
                documentId = "document-1",
                contractVersion = "2",
            }
        );
        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        var record = await client.GetStringAsync(
            "/internal/diagnostics/" + result.GetProperty("attemptId").GetString()
        );
        Assert.DoesNotContain("violet-cactus-782", record, StringComparison.Ordinal);
    }

    [Fact]
    public async Task IncompleteUpstreamContractCannotBeReportedAsSuccessfulResolution()
    {
        await using var app = database.Create(new ResolverHandler { MissingDiagnostics = true });
        using var client = app.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/api/pages/page-malformed/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                contractVersion = "2",
            }
        );
        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        var records = await client.GetFromJsonAsync<JsonElement>("/internal/diagnostics?pageId=page-malformed");
        Assert.Equal(
            "invalid_resolver_response",
            records[0].GetProperty("result").GetProperty("diagnostics").GetProperty("code").GetString()
        );
    }

    [Fact]
    public async Task OriginalInstructionOutlivesPageEvidenceForLegacyResults()
    {
        var clock = new TestClock(DateTimeOffset.UtcNow);
        await using var app = database.Create(new ResolverHandler(), clock);
        using var client = app.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/api/pages/page-legacy/resolve",
            new
            {
                instruction = "Click the Save button in Profile",
                documentId = "document-1",
                contractVersion = "1",
            }
        );
        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        clock.Now = clock.Now.AddDays(30);
        using var prune = await client.PostAsync("/internal/diagnostics/prune", null);
        prune.EnsureSuccessStatusCode();
        var record = await client.GetFromJsonAsync<JsonElement>(
            "/internal/diagnostics/" + result.GetProperty("attemptId").GetString()
        );
        Assert.Equal("expired", record.GetProperty("evidenceAvailability").GetString());
        Assert.Equal(JsonValueKind.Null, record.GetProperty("evidence").ValueKind);
        Assert.Equal(
            "Click the Save button in Profile",
            record.GetProperty("result").GetProperty("instruction").GetString()
        );
    }
}
