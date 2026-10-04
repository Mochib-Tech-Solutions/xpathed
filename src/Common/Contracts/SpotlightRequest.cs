using System.ComponentModel.DataAnnotations;

namespace Xpathed.Common.Contracts;

public sealed record SpotlightRequest(
    [Required, StringLength(64)] string DocumentId,
    [Required, StringLength(64)] string CaptureId,
    [StringLength(64, MinimumLength = 1)] string? ActionId
);
