using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Xpathed.Common.Http;

public static partial class ApiErrorHandling
{
    [LoggerMessage(Level = LogLevel.Warning, Message = "Request failed: {Code} {TraceId} {ExceptionType}")]
    private static partial void LogRequestFailure(ILogger logger, string code, string traceId, string exceptionType);

    public static void UseApiErrors(this WebApplication app)
    {
        app.Use(async (context, next) =>
        {
            try
            {
                await next(context);
            }
            catch (Exception error) when (!context.Response.HasStarted)
            {
                var (status, code, message) = error switch
                {
                    ApiException api => (api.Status, api.Code, api.Message),
                    BadHttpRequestException => (400, "invalid_request", "The request is invalid."),
                    OperationCanceledException when (context.RequestAborted.IsCancellationRequested) =>
                        (499, "cancelled", "The request was cancelled."),
                    OperationCanceledException => (504, "upstream_timeout", "The service did not respond in time."),
                    HttpRequestException => (502, "service_unavailable", "A required service is unavailable."),
                    _ => (500, "operation_failed", "The operation failed. Try a fresh session.")
                };
                // Keep page content, navigation URLs and upstream exception messages out of logs.
                LogRequestFailure(app.Logger, code, context.TraceIdentifier, error.GetType().Name);
                context.Response.StatusCode = status;
                await context.Response.WriteAsJsonAsync(new { code, message, traceId = context.TraceIdentifier });
            }
        });
    }
}
