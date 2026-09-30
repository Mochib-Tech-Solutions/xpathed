using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Xpathed.ClientApi.Data;
using Xpathed.Common.Diagnostics;
using Xpathed.Common.Http;

namespace Xpathed.ClientApi.Diagnostics;

public sealed class DiagnosticStore(AppDbContext database, TimeProvider clock, IConfiguration configuration)
{
    public static JsonSerializerOptions JsonOptions { get; } = new(JsonSerializerDefaults.Web);
    private static readonly JsonSerializerOptions ImportOptions = new(JsonOptions)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    public async Task BeginAsync(
        string id,
        string traceId,
        string pageId,
        string requestJson,
        CancellationToken cancellationToken
    )
    {
        var now = clock.GetUtcNow();
        database.DiagnosticRecords.Add(
            new DiagnosticRecord
            {
                Id = id,
                TraceId = traceId,
                PageId = pageId,
                CreatedAt = now,
                ResultJson = DiagnosticSanitizer.SanitizeJson(requestJson),
                ExpiresAt = now.AddDays(configuration.GetValue("Diagnostics:RecordRetentionDays", 90)),
                EvidenceExpiresAt = now.AddDays(configuration.GetValue("Diagnostics:CaptureRetentionDays", 30)),
                ProvenanceJson = JsonSerializer.Serialize(
                    new
                    {
                        source = "client-api",
                        schemaVersion = "1",
                        codeVersion = configuration["ReleaseId"] ?? "unavailable",
                        configurationId = "unavailable",
                        caseId = "unavailable",
                    },
                    JsonOptions
                ),
            }
        );
        await database.SaveChangesAsync(cancellationToken);
    }

    public async Task CompleteAsync(
        string id,
        string outcome,
        string resultJson,
        string? evidenceJson,
        string availability,
        CancellationToken cancellationToken
    )
    {
        var record = await database.DiagnosticRecords.FindAsync([id], cancellationToken);
        if (record is null)
        {
            return;
        }
        record.Outcome = outcome;
        var instruction = Instruction(evidenceJson);
        var completed = JsonNode.Parse(resultJson)!;
        var originalInstruction = Instruction(record.ResultJson);
        if (originalInstruction is not null)
        {
            completed["instruction"] = originalInstruction;
        }
        record.ResultJson = DiagnosticSanitizer.SanitizeJson(completed.ToJsonString(), instruction);
        record.EvidenceJson = evidenceJson is null ? null : DiagnosticSanitizer.SanitizeJson(evidenceJson, instruction);
        record.EvidenceAvailability = availability;
        var result = JsonSerializer.Deserialize<JsonElement>(record.ResultJson);
        if (
            result.TryGetProperty("configurationId", out var configurationId)
            && configurationId.ValueKind == JsonValueKind.String
            && Identifier(configurationId.GetString(), 200)
        )
        {
            var provenance = JsonNode.Parse(record.ProvenanceJson)!;
            provenance["configurationId"] = configurationId.GetString();
            record.ProvenanceJson = provenance.ToJsonString();
        }
        await database.SaveChangesAsync(cancellationToken);
    }

    public async Task<DiagnosticExport?> GetAsync(string id, CancellationToken cancellationToken)
    {
        var record = await database
            .DiagnosticRecords.AsNoTracking()
            .SingleOrDefaultAsync(item => item.Id == id, cancellationToken);
        if (record is null || record.ExpiresAt <= clock.GetUtcNow())
        {
            return null;
        }
        return Export(record);
    }

    public async Task<DiagnosticExport[]> ListAsync(
        string? pageId,
        string? traceId,
        int limit,
        CancellationToken cancellationToken
    )
    {
        if (
            limit is < 1 or > 100
            || pageId is not null && !Identifier(pageId, 128)
            || traceId is not null && !Identifier(traceId, 128)
        )
        {
            throw InvalidArtifact();
        }
        var now = clock.GetUtcNow();
        var query = database
            .DiagnosticRecords.AsNoTracking()
            .Where(item => item.ExpiresAt == null || item.ExpiresAt > now);
        if (pageId is not null)
        {
            query = query.Where(item => item.PageId == pageId);
        }
        if (traceId is not null)
        {
            query = query.Where(item => item.TraceId == traceId);
        }
        return (
            await query
                .OrderByDescending(item => item.CreatedAt)
                .ThenBy(item => item.Id)
                .Take(limit)
                .ToArrayAsync(cancellationToken)
        )
            .Select(item => Export(item))
            .ToArray();
    }

    public async Task<DiagnosticExport> ImportAsync(JsonElement document, CancellationToken cancellationToken)
    {
        if (Encoding.UTF8.GetByteCount(document.GetRawText()) > 2_000_000)
        {
            throw new ApiException(413, "artifact_too_large", "Diagnostic imports are limited to 2 MB.");
        }
        DiagnosticExport artifact;
        try
        {
            artifact = document.Deserialize<DiagnosticExport>(ImportOptions) ?? throw InvalidArtifact();
        }
        catch (JsonException)
        {
            throw InvalidArtifact();
        }
        if (
            artifact.Version != "1"
            || artifact.Kind
                is not (
                    "resolution"
                    or "evaluation"
                    or "saved_case"
                    or "model_configuration"
                    or "regression_fixture"
                    or "qualification"
                )
            || !Identifier(artifact.Id, 80)
            || !Identifier(artifact.TraceId, 128)
            || !Identifier(artifact.PageId, 128)
            || !Identifier(artifact.Outcome, 40)
            || !Identifier(artifact.EvidenceAvailability, 80)
            || artifact.Result.ValueKind != JsonValueKind.Object
            || artifact.Provenance.ValueKind != JsonValueKind.Object
            || artifact.Evidence is { ValueKind: not JsonValueKind.Object and not JsonValueKind.Null }
            || artifact.CreatedAt == default
            || artifact.CreatedAt > clock.GetUtcNow().AddMinutes(5)
        )
        {
            throw InvalidArtifact();
        }
        if (
            artifact.Kind == "resolution"
            && (
                artifact.Outcome is not ("pending" or "found" or "not_found" or "unsupported" or "error" or "partial")
                || !artifact.Result.TryGetProperty("outcome", out var resultOutcome)
                || resultOutcome.ValueKind != JsonValueKind.String
                || resultOutcome.GetString() != artifact.Outcome
                || !artifact.Result.TryGetProperty("attemptId", out var attempt)
                || attempt.ValueKind != JsonValueKind.String
                || attempt.GetString() != artifact.Id
            )
        )
        {
            throw InvalidArtifact();
        }
        if (ContainsPagePayload(artifact.Result) || ContainsPagePayload(artifact.Provenance))
        {
            throw new ApiException(
                400,
                "invalid_artifact",
                "Page captures and model input belong only in expiring evidence."
            );
        }
        foreach (var key in new[] { "source", "schemaVersion", "codeVersion", "configurationId", "caseId" })
        {
            if (
                !artifact.Provenance.TryGetProperty(key, out var value)
                || value.ValueKind != JsonValueKind.String
                || string.IsNullOrWhiteSpace(value.GetString())
                || value.GetString()!.Length > 200
            )
            {
                throw InvalidArtifact();
            }
        }
        if (artifact.Provenance.GetProperty("schemaVersion").GetString() != "1")
        {
            throw InvalidArtifact();
        }
        var approved =
            artifact.Provenance.TryGetProperty("approved", out var approval)
            && approval.ValueKind == JsonValueKind.True;
        if (
            approved
            && (
                !artifact.Provenance.TryGetProperty("reviewedBy", out var reviewer)
                || reviewer.ValueKind != JsonValueKind.String
                || string.IsNullOrWhiteSpace(reviewer.GetString())
                || reviewer.GetString()!.Length > 200
                || !artifact.Provenance.TryGetProperty("reviewedAt", out var reviewed)
                || reviewed.ValueKind != JsonValueKind.String
                || !reviewed.TryGetDateTimeOffset(out var reviewedAt)
                || reviewedAt > clock.GetUtcNow().AddMinutes(5)
            )
        )
        {
            throw InvalidArtifact();
        }
        var retained = approved && artifact.Kind is "regression_fixture" or "qualification";
        var sanitized = JsonSerializer.Deserialize<JsonElement>(
            DiagnosticSanitizer.SanitizeJson(
                JsonSerializer.Serialize(
                    new
                    {
                        artifact.Result,
                        artifact.Evidence,
                        artifact.Provenance,
                    },
                    JsonOptions
                )
            )
        );
        var record = new DiagnosticRecord
        {
            Id = artifact.Id,
            Kind = artifact.Kind,
            TraceId = artifact.TraceId,
            PageId = artifact.PageId,
            Outcome = artifact.Outcome,
            CreatedAt = artifact.CreatedAt.ToUniversalTime(),
            ExpiresAt = retained
                ? null
                : Expiry(artifact.CreatedAt, artifact.ExpiresAt, "Diagnostics:RecordRetentionDays", 90),
            EvidenceExpiresAt = retained
                ? null
                : Expiry(artifact.CreatedAt, artifact.EvidenceExpiresAt, "Diagnostics:CaptureRetentionDays", 30),
            EvidenceAvailability = artifact.Evidence is null or { ValueKind: JsonValueKind.Null }
                ? "unavailable"
                : artifact.EvidenceAvailability,
            ResultJson = sanitized.GetProperty("result").GetRawText(),
            EvidenceJson = artifact.Evidence is null or { ValueKind: JsonValueKind.Null }
                ? null
                : sanitized.GetProperty("evidence").GetRawText(),
            ProvenanceJson = sanitized.GetProperty("provenance").GetRawText(),
        };
        record.ImportHash = Hash(Export(record, false));
        if (record.EvidenceExpiresAt <= clock.GetUtcNow())
        {
            record.EvidenceJson = null;
            record.EvidenceAvailability = "expired";
        }
        database.DiagnosticRecords.Add(record);
        try
        {
            await database.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException error)
            when (error.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            database.Entry(record).State = EntityState.Detached;
            var original = await database
                .DiagnosticRecords.AsNoTracking()
                .SingleAsync(item => item.Id == record.Id, cancellationToken);
            if ((original.ImportHash ?? Hash(Export(original, false))) != record.ImportHash)
            {
                throw new ApiException(
                    409,
                    "artifact_conflict",
                    "This artifact ID already belongs to a different original record."
                );
            }
            return Export(original);
        }
        return Export(record);
    }

    public async Task<int> PruneAsync(CancellationToken cancellationToken)
    {
        var now = clock.GetUtcNow();
        var expired = database
            .DiagnosticRecords.Where(item => item.ExpiresAt <= now)
            .OrderBy(item => item.ExpiresAt)
            .Take(1000);
        var deleted = await expired.ExecuteDeleteAsync(cancellationToken);
        var evidence = database
            .DiagnosticRecords.Where(item => item.EvidenceExpiresAt <= now && item.EvidenceJson != null)
            .OrderBy(item => item.EvidenceExpiresAt)
            .Take(1000);
        return deleted
            + await evidence.ExecuteUpdateAsync(
                update =>
                    update
                        .SetProperty(item => item.EvidenceJson, (string?)null)
                        .SetProperty(item => item.EvidenceAvailability, "expired"),
                cancellationToken
            );
    }

    public Task<int> DeleteAsync(string id, CancellationToken cancellationToken) =>
        database.DiagnosticRecords.Where(item => item.Id == id).ExecuteDeleteAsync(cancellationToken);

    private DiagnosticExport Export(DiagnosticRecord record, bool applyExpiry = true)
    {
        var expired = applyExpiry && record.EvidenceExpiresAt <= clock.GetUtcNow();
        var instruction = Instruction(record.EvidenceJson);
        return new(
            "1",
            record.Id,
            record.Kind,
            record.TraceId,
            record.PageId,
            record.Outcome,
            record.CreatedAt,
            record.ExpiresAt,
            record.EvidenceExpiresAt,
            expired ? "expired" : record.EvidenceAvailability,
            JsonSerializer.Deserialize<JsonElement>(DiagnosticSanitizer.SanitizeJson(record.ResultJson, instruction)),
            expired || record.EvidenceJson is null
                ? null
                : JsonSerializer.Deserialize<JsonElement>(
                    DiagnosticSanitizer.SanitizeJson(record.EvidenceJson, instruction)
                ),
            JsonSerializer.Deserialize<JsonElement>(DiagnosticSanitizer.SanitizeJson(record.ProvenanceJson))
        );
    }

    private DateTimeOffset Expiry(DateTimeOffset createdAt, DateTimeOffset? requested, string key, int fallback)
    {
        var maximum = createdAt.AddDays(Math.Clamp(configuration.GetValue(key, fallback), 1, 3650));
        if (requested < createdAt)
        {
            throw InvalidArtifact();
        }
        return (requested is { } value && value < maximum ? value : maximum).ToUniversalTime();
    }

    private static bool Identifier(string? value, int limit) =>
        !string.IsNullOrWhiteSpace(value)
        && value.Length <= limit
        && value.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or '.' or ':')
        && DiagnosticSanitizer.SanitizeText(value) == value;

    private static ApiException InvalidArtifact() =>
        new(400, "invalid_artifact", "The diagnostic envelope or provenance is invalid.");

    private static string? Instruction(string? evidence) =>
        evidence is not null
        && JsonSerializer.Deserialize<JsonElement>(evidence) is var document
        && document.ValueKind == JsonValueKind.Object
        && document.TryGetProperty("instruction", out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static bool ContainsPagePayload(JsonElement value, int depth = 0)
    {
        if (depth > 32)
        {
            return true;
        }
        if (value.ValueKind == JsonValueKind.Array)
        {
            return value.EnumerateArray().Any(item => ContainsPagePayload(item, depth + 1));
        }
        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                var name = property.Name.ToLowerInvariant();
                if (property.Value.ValueKind == JsonValueKind.Null)
                {
                    continue;
                }
                if (name is "modelinput" or "candidates" or "capturejson" or "pageevidence")
                {
                    return true;
                }
                if (
                    name == "capture"
                    && (
                        property.Value.ValueKind != JsonValueKind.Object
                        || property
                            .Value.EnumerateObject()
                            .Any(field =>
                                field.Name
                                    is not (
                                        "scannedCount"
                                        or "eligibleCount"
                                        or "capturedCount"
                                        or "complete"
                                        or "errorCode"
                                    )
                            )
                    )
                )
                {
                    return true;
                }
                if (ContainsPagePayload(property.Value, depth + 1))
                {
                    return true;
                }
            }
        }
        else if (
            value.ValueKind == JsonValueKind.String
            && value.GetString() is { } text
            && (text.TrimStart().StartsWith('{') || text.TrimStart().StartsWith('['))
        )
        {
            try
            {
                using var nested = JsonDocument.Parse(text);
                return ContainsPagePayload(nested.RootElement, depth + 1);
            }
            catch (JsonException) { }
        }
        return false;
    }

    private static string Hash(DiagnosticExport artifact)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            Write(JsonSerializer.SerializeToElement(artifact, JsonOptions), writer);
        }
        return Convert.ToHexString(SHA256.HashData(stream.ToArray()));

        static void Write(JsonElement value, Utf8JsonWriter writer)
        {
            if (value.ValueKind == JsonValueKind.Object)
            {
                writer.WriteStartObject();
                foreach (
                    var property in value.EnumerateObject().OrderBy(property => property.Name, StringComparer.Ordinal)
                )
                {
                    writer.WritePropertyName(property.Name);
                    Write(property.Value, writer);
                }
                writer.WriteEndObject();
            }
            else if (value.ValueKind == JsonValueKind.Array)
            {
                writer.WriteStartArray();
                foreach (var item in value.EnumerateArray())
                {
                    Write(item, writer);
                }
                writer.WriteEndArray();
            }
            else
            {
                value.WriteTo(writer);
            }
        }
    }
}
