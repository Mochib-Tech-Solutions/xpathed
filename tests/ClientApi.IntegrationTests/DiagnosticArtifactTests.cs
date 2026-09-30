using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Npgsql;

namespace Xpathed.ClientApi.IntegrationTests;

public sealed class DiagnosticArtifactTests(PersistenceFixture database) : IClassFixture<PersistenceFixture>
{
    [Fact]
    public async Task EvaluationCaptureTimingsSurviveImportAndExport()
    {
        await using var app = database.Create(new ResolverHandler());
        using var client = app.CreateClient();
        var id = Guid.NewGuid().ToString("N");
        var artifact = Artifact(id, DateTimeOffset.UtcNow);
        artifact["kind"] = "evaluation";
        artifact["result"]!["diagnostics"] = new JsonObject { ["timingsMs"] = new JsonObject { ["capture"] = 12.5 } };
        artifact["result"]!["grade"] = new JsonObject
        {
            ["metrics"] = new JsonObject { ["stageTimingsMs"] = new JsonObject { ["capture"] = 12.5 } },
        };
        using var imported = await client.PostAsJsonAsync("/internal/diagnostics/import", artifact);
        Assert.Equal(HttpStatusCode.OK, imported.StatusCode);
        var exported = await client.GetFromJsonAsync<JsonElement>($"/internal/diagnostics/{id}");
        var result = exported.GetProperty("result");
        Assert.Equal(
            12.5,
            result.GetProperty("diagnostics").GetProperty("timingsMs").GetProperty("capture").GetDouble()
        );
        Assert.Equal(
            12.5,
            result
                .GetProperty("grade")
                .GetProperty("metrics")
                .GetProperty("stageTimingsMs")
                .GetProperty("capture")
                .GetDouble()
        );
    }

    [Theory]
    [InlineData("modelInput", "{\"candidates\":[{\"value\":\"violet-cactus-782\"}]}")]
    [InlineData("configurationJson", "{\"apiKey\":\"violet-cactus-782\"}")]
    public async Task EncodedJsonIsSanitizedWithoutSensitiveInstruction(string field, string payload)
    {
        await using var app = database.Create(new ResolverHandler());
        using var client = app.CreateClient();
        var id = Guid.NewGuid().ToString("N");
        var artifact = Artifact(id, DateTimeOffset.UtcNow);
        artifact["evidence"]![field] = payload;
        using var response = await client.PostAsJsonAsync("/internal/diagnostics/import", artifact);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var exported = await client.GetStringAsync($"/internal/diagnostics/{id}");
        Assert.DoesNotContain("violet-cactus-782", exported, StringComparison.Ordinal);
        await using var connection = new NpgsqlConnection(database.ConnectionString);
        await connection.OpenAsync();
        await using var query = new NpgsqlCommand(
            "SELECT \"EvidenceJson\"::text FROM diagnostic_records WHERE \"Id\" = @id",
            connection
        );
        query.Parameters.AddWithValue("id", id);
        Assert.DoesNotContain(
            "violet-cactus-782",
            (string)(await query.ExecuteScalarAsync())!,
            StringComparison.Ordinal
        );
    }

    [Fact]
    public async Task ImportsSanitizeDeduplicateAndPreserveOriginalOutcomes()
    {
        await using var app = database.Create(new ResolverHandler());
        using var client = app.CreateClient();
        var id = Guid.NewGuid().ToString("N");
        var artifact = Artifact(id, DateTimeOffset.UtcNow);
        artifact["result"]!["password"] = "synthetic-private-value";
        artifact["result"]!["configurationJson"] = "{\"apiKey\":\"violet-cactus-782\"}";
        artifact["result"]!["instruction"] = "Fill Name with violet-cactus-782";
        artifact["result"]!["html"] = "<input value='violet-cactus-782'>";
        artifact["result"]!["rawDOM"] = "<input value='violet-cactus-782'>";
        artifact["result"]!["body"] = "violet-cactus-782";
        artifact["result"]!["headers"] = new JsonObject { ["X-Private"] = "violet-cactus-782" };
        artifact["evidence"]!["modelInput"] = "{\"candidates\":[{\"label\":\"violet-cactus-782\"}]}";
        artifact["provenance"]!["url"] = "https://example.com/path?token=synthetic-query";
        var responses = await Task.WhenAll(
            Enumerable.Range(0, 4).Select(_ => client.PostAsJsonAsync("/internal/diagnostics/import", artifact))
        );
        foreach (var response in responses)
        {
            using (response)
            {
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            }
        }
        var exported = await client.GetStringAsync($"/internal/diagnostics/{id}");
        Assert.DoesNotContain("synthetic-private-value", exported, StringComparison.Ordinal);
        Assert.DoesNotContain("synthetic-query", exported, StringComparison.Ordinal);
        Assert.DoesNotContain("violet-cactus-782", exported, StringComparison.Ordinal);
        Assert.Contains("[redacted]", exported, StringComparison.Ordinal);
        artifact["outcome"] = "found";
        artifact["result"]!["outcome"] = "found";
        using var conflict = await client.PostAsJsonAsync("/internal/diagnostics/import", artifact);
        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        using var original = JsonDocument.Parse(await client.GetStringAsync($"/internal/diagnostics/{id}"));
        Assert.Equal("not_found", original.RootElement.GetProperty("outcome").GetString());
        var records = await client.GetFromJsonAsync<JsonElement>($"/internal/diagnostics?traceId=trace-{id}&limit=1");
        Assert.Equal(1, records.GetArrayLength());
        Assert.Equal(id, records[0].GetProperty("id").GetString());
    }

    [Fact]
    public async Task ImportRejectsMalformedUnknownAndBrowserOriginRequests()
    {
        await using var app = database.Create(new ResolverHandler());
        using var client = app.CreateClient();
        foreach (var field in new[] { "version", "kind", "provenance", "result", "id" })
        {
            var artifact = Artifact(Guid.NewGuid().ToString("N"), DateTimeOffset.UtcNow);
            artifact[field] = field is "provenance" or "result" ? null : "unknown/invalid";
            using var response = await client.PostAsJsonAsync("/internal/diagnostics/import", artifact);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        }
        using var request = new HttpRequestMessage(HttpMethod.Post, "/internal/diagnostics/import")
        {
            Content = JsonContent.Create(Artifact(Guid.NewGuid().ToString("N"), DateTimeOffset.UtcNow)),
        };
        request.Headers.Add("Origin", "http://localhost");
        using var forbidden = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
    }

    [Theory]
    [InlineData("\"page-only-label\"")]
    [InlineData("[\"page-only-label\"]")]
    [InlineData("{\"label\":\"page-only-label\"}")]
    public async Task NonMetricCapturePayloadCannotBypassEvidenceRetention(string payload)
    {
        await using var app = database.Create(new ResolverHandler());
        using var client = app.CreateClient();
        var artifact = Artifact(Guid.NewGuid().ToString("N"), DateTimeOffset.UtcNow);
        artifact["result"]!["capture"] = JsonNode.Parse(payload);
        using var response = await client.PostAsJsonAsync("/internal/diagnostics/import", artifact);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("result", "modelInput")]
    [InlineData("provenance", "capture")]
    public async Task PagePayloadCannotBypassEvidenceRetention(string section, string field)
    {
        await using var app = database.Create(new ResolverHandler());
        using var client = app.CreateClient();
        var artifact = Artifact(Guid.NewGuid().ToString("N"), DateTimeOffset.UtcNow);
        artifact[section]![field] = new JsonObject
        {
            ["candidates"] = new JsonArray(new JsonObject { ["label"] = "page-only-label" }),
        };
        using var response = await client.PostAsJsonAsync("/internal/diagnostics/import", artifact);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("outcome", "found")]
    [InlineData("attemptId", "different-attempt")]
    public async Task ResolutionImportRejectsContradictoryIdentityAndOutcome(string field, string value)
    {
        await using var app = database.Create(new ResolverHandler());
        using var client = app.CreateClient();
        var artifact = Artifact(Guid.NewGuid().ToString("N"), DateTimeOffset.UtcNow);
        artifact["result"]![field] = value;
        using var response = await client.PostAsJsonAsync("/internal/diagnostics/import", artifact);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task ExpiryErasesEvidenceAndRecordsButReviewedFixturesNeedExplicitDeletion()
    {
        var clock = new TestClock(new DateTimeOffset(2026, 9, 30, 0, 0, 0, TimeSpan.Zero));
        await using var app = database.Create(new ResolverHandler(), clock);
        using var client = app.CreateClient();
        var id = Guid.NewGuid().ToString("N");
        var retainedId = Guid.NewGuid().ToString("N");
        using var ordinary = await client.PostAsJsonAsync("/internal/diagnostics/import", Artifact(id, clock.Now));
        Assert.Equal(HttpStatusCode.OK, ordinary.StatusCode);
        var fixture = Artifact(retainedId, clock.Now);
        fixture["kind"] = "regression_fixture";
        fixture["provenance"]!["approved"] = true;
        fixture["provenance"]!["reviewedBy"] = "maintainer";
        fixture["provenance"]!["reviewedAt"] = clock.Now;
        using var approved = await client.PostAsJsonAsync("/internal/diagnostics/import", fixture);
        Assert.Equal(HttpStatusCode.OK, approved.StatusCode);
        clock.Now = clock.Now.AddDays(30);
        using var prune = await client.PostAsync("/internal/diagnostics/prune", null);
        Assert.Equal(HttpStatusCode.OK, prune.StatusCode);
        var record = await client.GetFromJsonAsync<JsonElement>($"/internal/diagnostics/{id}");
        Assert.Equal("expired", record.GetProperty("evidenceAvailability").GetString());
        Assert.Equal(JsonValueKind.Null, record.GetProperty("evidence").ValueKind);
        using var duplicateAfterExpiry = await client.PostAsJsonAsync(
            "/internal/diagnostics/import",
            Artifact(id, clock.Now.AddDays(-30))
        );
        Assert.Equal(HttpStatusCode.OK, duplicateAfterExpiry.StatusCode);
        await using (var connection = new NpgsqlConnection(database.ConnectionString))
        {
            await connection.OpenAsync();
            await using var query = new NpgsqlCommand(
                "SELECT \"EvidenceJson\" IS NULL FROM diagnostic_records WHERE \"Id\" = @id",
                connection
            );
            query.Parameters.AddWithValue("id", id);
            Assert.Equal(true, await query.ExecuteScalarAsync());
        }
        clock.Now = clock.Now.AddDays(60);
        using var pruneRecords = await client.PostAsync("/internal/diagnostics/prune", null);
        Assert.Equal(HttpStatusCode.OK, pruneRecords.StatusCode);
        using var expired = await client.GetAsync($"/internal/diagnostics/{id}");
        Assert.Equal(HttpStatusCode.NotFound, expired.StatusCode);
        using var retained = await client.GetAsync($"/internal/diagnostics/{retainedId}");
        Assert.Equal(HttpStatusCode.OK, retained.StatusCode);
        using var delete = await client.DeleteAsync($"/internal/diagnostics/{retainedId}");
        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);
        using var deleted = await client.GetAsync($"/internal/diagnostics/{retainedId}");
        Assert.Equal(HttpStatusCode.NotFound, deleted.StatusCode);
    }

    private static JsonObject Artifact(string id, DateTimeOffset createdAt) =>
        new()
        {
            ["version"] = "1",
            ["id"] = id,
            ["kind"] = "resolution",
            ["traceId"] = "trace-" + id,
            ["pageId"] = "page-" + id,
            ["outcome"] = "not_found",
            ["createdAt"] = createdAt,
            ["evidenceAvailability"] = "available",
            ["result"] = new JsonObject { ["outcome"] = "not_found", ["attemptId"] = id },
            ["evidence"] = new JsonObject { ["instruction"] = "Click Save" },
            ["provenance"] = new JsonObject
            {
                ["source"] = "operator",
                ["schemaVersion"] = "1",
                ["codeVersion"] = "test",
                ["configurationId"] = "config-1",
                ["caseId"] = "case-1",
            },
        };
}
