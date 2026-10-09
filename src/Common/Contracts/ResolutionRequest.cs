using System.ComponentModel.DataAnnotations;

namespace Xpathed.Common.Contracts;

public sealed record ResolutionRequest(
    [Required, StringLength(4000)] string Instruction,
    [Required, StringLength(64)] string DocumentId,
    [Required, RegularExpression("auto|text_only")] string ImageMode = "auto"
);
