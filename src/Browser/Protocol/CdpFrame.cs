using System.Text.Json;

namespace Xpathed.Browser.Protocol;

internal sealed class CdpFrame(CdpPage page, string id, string sessionId)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    public CdpPage Page { get; } = page;
    public string Id { get; } = id;
    public string SessionId { get; set; } = sessionId;
    public CdpContext? Context { get; set; }
    public bool IsDetached { get; set; }
    public string? ParentId { get; set; }
    public string Url { get; set; } = "about:blank";

    public Task<JsonElement> SendAsync(string method, object? parameters = null) =>
        Page.Connection.SendAsync(method, parameters, SessionId);

    public async Task<T> EvaluateAsync<T>(string expression, object? argument = null)
    {
        var (response, _) = await EvaluateCoreAsync(expression, argument, true);
        return Value<T>(response);
    }

    public async Task<CdpRemoteObject> EvaluateHandleAsync(string expression, object? argument = null)
    {
        var (response, context) = await EvaluateCoreAsync(expression, argument, false);
        return new(this, ObjectId(response), context);
    }

    private async Task<(JsonElement Response, CdpContext Context)> EvaluateCoreAsync(
        string expression,
        object? argument,
        bool returnByValue
    )
    {
        var timer = System.Diagnostics.Stopwatch.StartNew();
        while ((Context is null || Context.SessionId != SessionId) && !IsDetached && timer.ElapsedMilliseconds < 10000)
        {
            await Task.Delay(10);
        }
        var context = Context;
        if (IsDetached || context is null || context.SessionId != SessionId)
        {
            throw new CdpException("The target document is no longer available.");
        }
        var source =
            expression.Contains("=>", StringComparison.Ordinal)
            || expression.StartsWith("function", StringComparison.Ordinal)
                ? "(" + expression + ")(" + JsonSerializer.Serialize(argument) + ")"
                : expression;
        var response = await Page.DocumentCommandAsync(() =>
            Page.Connection.SendAsync(
                "Runtime.evaluate",
                new
                {
                    expression = source,
                    uniqueContextId = context.UniqueId,
                    awaitPromise = true,
                    returnByValue,
                    userGesture = false,
                },
                context.SessionId
            )
        );
        if (Context != context || IsDetached)
        {
            throw new CdpException("The target document changed during evaluation.");
        }
        return (response, context);
    }

    internal static T Value<T>(JsonElement response)
    {
        if (response.TryGetProperty("exceptionDetails", out _))
        {
            throw new CdpException("The browser could not evaluate the retained document.");
        }
        var result = response.GetProperty("result");
        if (!result.TryGetProperty("value", out var value))
        {
            return typeof(T) == typeof(JsonElement)
                ? (T)(object)JsonSerializer.SerializeToElement<object?>(null)
                : default!;
        }
        return value.Deserialize<T>(JsonOptions)!;
    }

    internal static string ObjectId(JsonElement response)
    {
        if (
            response.TryGetProperty("exceptionDetails", out _)
            || !response.GetProperty("result").TryGetProperty("objectId", out var id)
        )
        {
            throw new CdpException("The retained browser object is no longer available.");
        }
        return id.GetString()!;
    }
}
