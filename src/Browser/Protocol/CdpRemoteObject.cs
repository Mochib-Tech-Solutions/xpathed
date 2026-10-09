using System.Text.Json;
using System.Text.Json.Serialization;

namespace Xpathed.Browser.Protocol;

internal sealed class CdpRemoteObject(CdpFrame frame, string objectId, CdpContext context) : IAsyncDisposable
{
    public CdpFrame Frame { get; } = frame;
    public string ObjectId { get; } = objectId;
    public CdpContext Context { get; } = context;

    private void EnsureCurrent()
    {
        if (Frame.IsDetached || Frame.Context != Context || Frame.SessionId != Context.SessionId)
        {
            throw new CdpException("The retained document is no longer current.");
        }
    }

    public Task<T> EvaluateAsync<T>(string function, object? argument = null) => CallAsync<T>(function, argument);

    public async Task EvaluateAsync(string function, object? argument = null) =>
        await CallAsync<JsonElement>(function, argument);

    private async Task<T> CallAsync<T>(string function, object? argument)
    {
        var response = await InvokeAsync(function, argument, true);
        EnsureCurrent();
        return CdpFrame.Value<T>(response);
    }

    public async Task<CdpRemoteObject> EvaluateHandleAsync(
        string function,
        object? argument = null,
        Action? beforeSend = null
    )
    {
        var response = await InvokeAsync(function, argument, false, beforeSend);
        EnsureCurrent();
        return new(Frame, CdpFrame.ObjectId(response), Context);
    }

    private Task<JsonElement> InvokeAsync(
        string function,
        object? argument,
        bool returnByValue,
        Action? beforeSend = null
    )
    {
        EnsureCurrent();
        var references = new List<CdpRemoteObject>();
        // Each call owns its remote-object reference table; sharing this converter would mix concurrent calls.
#pragma warning disable CA1869
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
#pragma warning restore CA1869
        options.Converters.Add(new RemoteReferenceConverter(Context, references));
        var value = JsonSerializer.Serialize(argument, options);
        var declaration =
            "function(...refs) { const revive = value => { if (!value || typeof value !== 'object') return value; if (Object.hasOwn(value, '__remoteReference')) return refs[value.__remoteReference]; for (const key of Object.keys(value)) value[key] = revive(value[key]); return value; }; return ("
            + function
            + ")(this, revive("
            + value
            + ")); }";
        return Frame.Page.DocumentCommandAsync(() =>
            Frame.Page.Connection.SendAsync(
                "Runtime.callFunctionOn",
                new
                {
                    objectId = ObjectId,
                    functionDeclaration = declaration,
                    arguments = references.Select(reference => new { objectId = reference.ObjectId }).ToArray(),
                    returnByValue,
                    awaitPromise = true,
                    userGesture = false,
                },
                Context.SessionId,
                () =>
                {
                    EnsureCurrent();
                    beforeSend?.Invoke();
                }
            )
        );
    }

    public async Task<CdpFrame?> ContentFrameAsync()
    {
        EnsureCurrent();
        var result = await Frame.Page.Connection.SendAsync(
            "DOM.describeNode",
            new { objectId = ObjectId },
            Context.SessionId
        );
        EnsureCurrent();
        var child = result.GetProperty("node").TryGetProperty("frameId", out var id)
            ? await Frame.Page.FindFrameAsync(id.GetString()!)
            : null;
        EnsureCurrent();
        return child;
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            await Frame.Page.Connection.SendAsync(
                "Runtime.releaseObject",
                new { objectId = ObjectId },
                Context.SessionId
            );
        }
        catch (CdpException) { }
        catch (OperationCanceledException) { }
    }

    private sealed class RemoteReferenceConverter(CdpContext context, List<CdpRemoteObject> references)
        : JsonConverter<CdpRemoteObject>
    {
        public override CdpRemoteObject Read(
            ref Utf8JsonReader reader,
            Type typeToConvert,
            JsonSerializerOptions options
        ) => throw new NotSupportedException();

        public override void Write(Utf8JsonWriter writer, CdpRemoteObject value, JsonSerializerOptions options)
        {
            value.EnsureCurrent();
            if (value.Context != context)
            {
                throw new CdpException("Remote objects must belong to the same browser context.");
            }
            writer.WriteStartObject();
            writer.WriteNumber("__remoteReference", references.Count);
            writer.WriteEndObject();
            references.Add(value);
        }
    }
}
