using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Xpathed.ClientApi.Data.Migrations;

/// <inheritdoc />
public partial class InitialDiagnostics : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "diagnostic_records",
            columns: table => new
            {
                Id = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                Kind = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                TraceId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                PageId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                Outcome = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                EvidenceExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                EvidenceAvailability = table.Column<string>(
                    type: "character varying(80)",
                    maxLength: 80,
                    nullable: false
                ),
                ResultJson = table.Column<string>(type: "jsonb", nullable: false),
                EvidenceJson = table.Column<string>(type: "jsonb", nullable: true),
                ProvenanceJson = table.Column<string>(type: "jsonb", nullable: false),
                ImportHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_diagnostic_records", x => x.Id);
            }
        );

        migrationBuilder.CreateIndex(
            name: "IX_diagnostic_records_EvidenceExpiresAt",
            table: "diagnostic_records",
            column: "EvidenceExpiresAt"
        );

        migrationBuilder.CreateIndex(
            name: "IX_diagnostic_records_ExpiresAt",
            table: "diagnostic_records",
            column: "ExpiresAt"
        );

        migrationBuilder.CreateIndex(
            name: "IX_diagnostic_records_PageId_CreatedAt",
            table: "diagnostic_records",
            columns: ["PageId", "CreatedAt"]
        );
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "diagnostic_records");
    }
}
