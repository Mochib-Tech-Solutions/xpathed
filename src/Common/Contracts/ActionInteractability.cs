namespace Xpathed.Common.Contracts;

public sealed record ActionInteractability(
    string Action,
    string Status,
    string[] Reasons,
    InteractabilityChecks Checks
);
