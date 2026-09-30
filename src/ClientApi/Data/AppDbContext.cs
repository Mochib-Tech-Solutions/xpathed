using Microsoft.EntityFrameworkCore;

namespace Xpathed.ClientApi.Data;

public sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<DiagnosticRecord> DiagnosticRecords => Set<DiagnosticRecord>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        var records = modelBuilder.Entity<DiagnosticRecord>();
        records.ToTable("diagnostic_records");
        records.HasKey(item => item.Id);
        records.Property(item => item.Id).HasMaxLength(80);
        records.Property(item => item.Kind).HasMaxLength(40);
        records.Property(item => item.TraceId).HasMaxLength(128);
        records.Property(item => item.PageId).HasMaxLength(128);
        records.Property(item => item.Outcome).HasMaxLength(40);
        records.Property(item => item.EvidenceAvailability).HasMaxLength(80);
        records.Property(item => item.ImportHash).HasMaxLength(64);
        records.Property(item => item.ResultJson).HasColumnType("jsonb");
        records.Property(item => item.EvidenceJson).HasColumnType("jsonb");
        records.Property(item => item.ProvenanceJson).HasColumnType("jsonb");
        records.HasIndex(item => item.ExpiresAt);
        records.HasIndex(item => item.EvidenceExpiresAt);
        records.HasIndex(item => new { item.PageId, item.CreatedAt });
    }
}
