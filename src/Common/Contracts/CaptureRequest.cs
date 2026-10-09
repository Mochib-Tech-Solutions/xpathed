using System.ComponentModel.DataAnnotations;

namespace Xpathed.Common.Contracts;

public sealed record CaptureRequest(
    [Required, StringLength(64)] string DocumentId,
    [Required, RegularExpression("current_view")] string Scope = "current_view",
    bool IncludeImage = false
);
