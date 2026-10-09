using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Xpathed.Browser.Protocol;

internal sealed class CdpConnection : IAsyncDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
    private Stream? input;
    private Stream? output;
    private readonly SemaphoreSlim sending = new(1);
    private readonly CancellationTokenSource stopping = new();
    private readonly object lifetime = new();
    private readonly TaskCompletionSource sendsFinished = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly ConcurrentDictionary<long, TaskCompletionSource<JsonElement>> pending = new();
    private long nextId;
    private Task? receiving;
    private int disposed;
    private int activeSends;

    public event Action<string?, string, JsonElement>? Event;
    public event Action? Disconnected;

    public void Connect(Stream input, Stream output)
    {
        if (this.input is not null || Volatile.Read(ref disposed) != 0)
        {
            throw new InvalidOperationException("The browser transport has already been initialized.");
        }
        this.input = input;
        this.output = output;
        receiving = ReceiveAsync();
    }

    public async Task<JsonElement> SendAsync(
        string method,
        object? parameters = null,
        string? sessionId = null,
        Action? beforeSend = null
    )
    {
        lock (lifetime)
        {
            if (disposed != 0 || stopping.IsCancellationRequested || output is null)
            {
                throw new CdpException("The managed browser disconnected.");
            }
            activeSends++;
        }
        var id = Interlocked.Increment(ref nextId);
        var completion = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[id] = completion;
        try
        {
            var message = JsonSerializer.SerializeToUtf8Bytes(
                new
                {
                    id,
                    method,
                    @params = parameters ?? new { },
                    sessionId,
                },
                JsonOptions
            );
            await sending.WaitAsync(stopping.Token);
            try
            {
                beforeSend?.Invoke();
                await output.WriteAsync(message, stopping.Token);
                await output.WriteAsync(new byte[] { 0 }, stopping.Token);
                await output.FlushAsync(stopping.Token);
            }
            finally
            {
                sending.Release();
            }
            return await completion.Task.WaitAsync(stopping.Token);
        }
        finally
        {
            pending.TryRemove(id, out _);
            lock (lifetime)
            {
                if (--activeSends == 0 && disposed != 0)
                {
                    sendsFinished.TrySetResult();
                }
            }
        }
    }

    private async Task ReceiveAsync()
    {
        var buffer = new byte[65536];
        using var message = new MemoryStream();
        try
        {
            while (!stopping.IsCancellationRequested)
            {
                var count = await input!.ReadAsync(buffer, stopping.Token);
                if (count == 0)
                {
                    return;
                }
                var start = 0;
                for (var index = 0; index < count; index++)
                {
                    if (buffer[index] != 0)
                    {
                        continue;
                    }
                    message.Write(buffer, start, index - start);
                    Dispatch(message.GetBuffer().AsMemory(0, checked((int)message.Length)));
                    message.SetLength(0);
                    start = index + 1;
                }
                message.Write(buffer, start, count - start);
            }
        }
        catch (Exception) { }
        finally
        {
            await stopping.CancelAsync();
            foreach (var completion in pending.Values)
            {
                completion.TrySetException(new CdpException("The managed browser disconnected."));
            }
            Disconnected?.Invoke();
        }
    }

    private void Dispatch(ReadOnlyMemory<byte> message)
    {
        using var document = JsonDocument.Parse(message, new JsonDocumentOptions { MaxDepth = int.MaxValue });
        var root = document.RootElement;
        if (root.TryGetProperty("id", out var id) && pending.TryRemove(id.GetInt64(), out var completion))
        {
            if (root.TryGetProperty("error", out _))
            {
                // Protocol errors may contain page source or values. Keep only a generic local error.
                completion.TrySetException(new CdpException("The browser rejected a protocol operation."));
            }
            else
            {
                completion.TrySetResult(root.GetProperty("result").Clone());
            }
        }
        else if (root.TryGetProperty("method", out var method))
        {
            Event?.Invoke(
                root.TryGetProperty("sessionId", out var session) ? session.GetString() : null,
                method.GetString()!,
                root.GetProperty("params").Clone()
            );
        }
    }

    public async ValueTask DisposeAsync()
    {
        lock (lifetime)
        {
            if (disposed != 0)
            {
                return;
            }
            disposed = 1;
            if (activeSends == 0)
            {
                sendsFinished.TrySetResult();
            }
        }
        await stopping.CancelAsync();
        input?.Dispose();
        output?.Dispose();
        if (receiving is not null)
        {
            await receiving;
        }
        await sendsFinished.Task;
        sending.Dispose();
        stopping.Dispose();
    }
}
