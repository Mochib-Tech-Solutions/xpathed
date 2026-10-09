namespace Xpathed.Common.Contracts;

public sealed record ActionExecutionResult(string ActionId, string Action, string Status, string Message);
