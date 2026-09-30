using System.ComponentModel.DataAnnotations;

namespace Xpathed.Common.Contracts;

public sealed record ActionSelection([Required, StringLength(64)] string ActionId, [StringLength(80)] string? CandidateId, [Required, StringLength(32)] string Action);
