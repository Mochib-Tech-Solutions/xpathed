using System.ComponentModel.DataAnnotations;

namespace Xpathed.Common.Contracts;

public sealed record CaptureImageRequest(
    [Required, StringLength(64)] string DocumentId,
    [Required, StringLength(64)] string CaptureId
);
