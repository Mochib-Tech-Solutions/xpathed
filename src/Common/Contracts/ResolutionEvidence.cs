namespace Xpathed.Common.Contracts;

public sealed record ResolutionEvidence(
    string Version,
    string Availability,
    string? Instruction,
    string? ModelInput,
    string? SystemPrompt,
    string? OutputSchema,
    string? ConfigurationJson
);
