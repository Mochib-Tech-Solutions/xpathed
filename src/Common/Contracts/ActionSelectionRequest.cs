using System.ComponentModel.DataAnnotations;

namespace Xpathed.Common.Contracts;

public sealed record ActionSelectionRequest(
    [Required, StringLength(64)] string DocumentId,
    [Required, StringLength(64)] string CaptureId,
    [Required, MinLength(1), MaxLength(16)] ActionSelection[] Actions,
    SelectionRule? Rule = null
);
