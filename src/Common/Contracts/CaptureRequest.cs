using System.ComponentModel.DataAnnotations;

namespace Xpathed.Common.Contracts;

public sealed record CaptureRequest([Required, StringLength(64)] string DocumentId);
