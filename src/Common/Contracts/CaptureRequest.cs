using System.ComponentModel.DataAnnotations;

namespace Xpathed.Common.Contracts;

public sealed record CaptureRequest(
    [Required, StringLength(64)] string DocumentId,
    [Required, RegularExpression("page|current_view")] string Scope = "page"
);
