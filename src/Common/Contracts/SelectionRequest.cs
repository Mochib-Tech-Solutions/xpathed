using System.ComponentModel.DataAnnotations;

namespace Xpathed.Common.Contracts;

public sealed record SelectionRequest(
    [Required, StringLength(64)] string DocumentId,
    [Required, StringLength(64)] string CaptureId,
    [StringLength(80)] string? CandidateId,
    [Required, StringLength(32)] string Action
);
