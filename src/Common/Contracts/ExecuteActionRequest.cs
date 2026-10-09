using System.ComponentModel.DataAnnotations;

namespace Xpathed.Common.Contracts;

public sealed record ExecuteActionRequest(
    [Required, StringLength(64)] string SessionId,
    [Required, StringLength(64)] string DocumentId,
    [Required, StringLength(64)] string CaptureId,
    [Required, StringLength(64)] string ActionId,
    [StringLength(10000)] string? Value = null
);
