namespace Xpathed.Common.Contracts;

public sealed record ApiError(string Code, string Message, string TraceId);
