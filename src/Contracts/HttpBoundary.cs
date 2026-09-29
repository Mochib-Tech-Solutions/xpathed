using System.Net.WebSockets;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Xpathed;

public sealed class ApiException(int status, string code, string message) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}

public static partial class HttpBoundary
{
    [LoggerMessage(Level = LogLevel.Warning, Message = "Request failed: {Code} {TraceId} {ExceptionType}")]
    private static partial void LogRequestFailure(ILogger logger, string code, string traceId, string exceptionType);

    public static void UseApiErrors(this WebApplication app)
    {
        app.Use(async (context, next) =>
        {
            try { await next(context); }
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

    public static async Task Forward(HttpContext context, HttpClient client, string path)
    {
        using var request = new HttpRequestMessage(new HttpMethod(context.Request.Method), path);
        if (context.Request.ContentLength > 0 || context.Request.Headers.ContainsKey("Transfer-Encoding"))
        {
            request.Content = new StreamContent(context.Request.Body);
            if (context.Request.ContentType is { } contentType)
                request.Content.Headers.TryAddWithoutValidation("Content-Type", contentType);
        }
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, context.RequestAborted);
        context.Response.StatusCode = (int)response.StatusCode;
        context.Response.ContentType = response.Content.Headers.ContentType?.ToString();
        await response.Content.CopyToAsync(context.Response.Body, context.RequestAborted);
    }

    public static async Task Relay(WebSocket socket, Stream stream, CancellationToken cancellationToken)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        async Task FromViewer()
        {
            var buffer = new byte[16384];
            while (!lifetime.IsCancellationRequested)
            {
                var result = await socket.ReceiveAsync(buffer.AsMemory(), lifetime.Token);
                if (result.MessageType == WebSocketMessageType.Close) return;
                if (result.MessageType != WebSocketMessageType.Binary) throw new IOException("Binary VNC data required.");
                await stream.WriteAsync(buffer.AsMemory(0, result.Count), lifetime.Token);
            }
        }
        async Task ToViewer()
        {
            var buffer = new byte[16384];
            int count;
            while ((count = await stream.ReadAsync(buffer, lifetime.Token)) > 0)
                await socket.SendAsync(buffer.AsMemory(0, count), WebSocketMessageType.Binary, true, lifetime.Token);
        }
        var sending = FromViewer();
        var receiving = ToViewer();
        await Task.WhenAny(sending, receiving);
        await lifetime.CancelAsync();
        try { await Task.WhenAll(sending, receiving); }
        catch (Exception error) when (error is OperationCanceledException or WebSocketException or IOException) { }
        socket.Abort();
    }
}
