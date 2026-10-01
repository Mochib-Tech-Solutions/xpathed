namespace Xpathed.Common.Contracts;

public sealed record CandidateAppearance(
    string? BackgroundColor,
    string? TextColor,
    string? BorderColor,
    string[] Limitations
);
