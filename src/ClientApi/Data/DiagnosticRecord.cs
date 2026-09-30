namespace Xpathed.ClientApi.Data;

public sealed class DiagnosticRecord
{
    public string Id { get; set; } = "";
    public string Kind { get; set; } = "resolution";
    public string TraceId { get; set; } = "";
    public string PageId { get; set; } = "";
    public string Outcome { get; set; } = "pending";
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
    public DateTimeOffset? EvidenceExpiresAt { get; set; }
    public string EvidenceAvailability { get; set; } = "unavailable";
    public string ResultJson { get; set; } = "{}";
    public string? EvidenceJson { get; set; }
    public string ProvenanceJson { get; set; } = "{}";
    public string? ImportHash { get; set; }
}
