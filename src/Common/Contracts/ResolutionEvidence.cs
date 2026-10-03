namespace Xpathed.Common.Contracts;

public sealed record ResolutionEvidence(
    string Availability,
    string? Instruction,
    string? ModelInput,
    string? SystemPrompt,
    string? OutputSchema,
    string? ConfigurationJson
);
