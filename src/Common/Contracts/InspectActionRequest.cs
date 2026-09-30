using System.ComponentModel.DataAnnotations;

namespace Xpathed.Common.Contracts;

public sealed record InspectActionRequest(
    [Required, StringLength(64)] string DocumentId,
    [Required, StringLength(64)] string CaptureId,
    [Required, StringLength(64)] string ActionId
);
