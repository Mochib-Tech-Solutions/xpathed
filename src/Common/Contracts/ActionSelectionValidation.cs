namespace Xpathed.Common.Contracts;

public sealed record ActionSelectionValidation(ValidatedAction[] Actions, string? InspectedActionId);
