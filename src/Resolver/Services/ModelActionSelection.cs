namespace Xpathed.Resolver.Services;

internal sealed record ModelActionSelection(int Step, string Instruction, string Outcome, string Action, string? CandidateId, string Limitation);
