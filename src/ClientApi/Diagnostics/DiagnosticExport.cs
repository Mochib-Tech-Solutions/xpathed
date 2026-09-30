using System.Text.Json;

namespace Xpathed.ClientApi.Diagnostics;

public sealed record DiagnosticExport(
    string Version,
    string Id,
    string Kind,
    string TraceId,
    string PageId,
    string Outcome,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ExpiresAt,
    DateTimeOffset? EvidenceExpiresAt,
    string EvidenceAvailability,
    JsonElement Result,
    JsonElement? Evidence,
    JsonElement Provenance
);
