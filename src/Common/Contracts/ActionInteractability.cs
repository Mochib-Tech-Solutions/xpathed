namespace Xpathed.Common.Contracts;

public sealed record ActionInteractability(string Version, string Action, string Status, string[] Reasons, InteractabilityChecks Checks);
