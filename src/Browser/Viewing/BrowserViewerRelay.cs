using System.Net.WebSockets;
using System.Text.Json;
using System.Threading.Channels;
using Xpathed.Browser.Protocol;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Viewing;

internal sealed class BrowserViewerRelay : IDisposable
{
    private readonly Channel<BrowserVideoFrame> frames = Channel.CreateBounded<BrowserVideoFrame>(
        new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropOldest }
    );
    private readonly Channel<object> controls = Channel.CreateBounded<object>(
        new BoundedChannelOptions(16) { FullMode = BoundedChannelFullMode.Wait }
    );
    private readonly CancellationTokenSource overflow = new();
    private readonly SemaphoreSlim sending = new(1);
    private long frameId;
    private int disposed;
    private TaskCompletionSource? acknowledgment;

    public void Publish(BrowserVideoFrame frame) => frames.Writer.TryWrite(frame);

    public void PublishControl(object message)
    {
        if (Volatile.Read(ref disposed) != 0)
        {
            return;
        }
        if (!controls.Writer.TryWrite(message))
        {
            try
            {
                overflow.Cancel();
            }
            catch (ObjectDisposedException) { }
        }
    }

    public void Dispose()
    {
        Interlocked.Exchange(ref disposed, 1);
        overflow.Dispose();
        sending.Dispose();
    }

    public async Task RunAsync(
        WebSocket socket,
        Func<JsonElement, CancellationToken, Task> handleInput,
        CancellationToken cancellationToken
    )
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, overflow.Token);
        var inputs = Channel.CreateBounded<JsonElement>(
            new BoundedChannelOptions(64) { FullMode = BoundedChannelFullMode.Wait }
        );
        async Task SendAsync(object message)
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(message, JsonSerializerOptions.Web);
            await sending.WaitAsync(lifetime.Token);
            try
            {
                await socket.SendAsync(bytes, WebSocketMessageType.Text, true, lifetime.Token);
            }
            finally
            {
                sending.Release();
            }
        }
        async Task SendFramesAsync()
        {
            await foreach (var frame in frames.Reader.ReadAllAsync(lifetime.Token))
            {
                var ack = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                var id = Interlocked.Increment(ref frameId);
                Volatile.Write(ref acknowledgment, ack);
                await SendAsync(
                    new
                    {
                        type = "frame",
                        frameId = id,
                        frame.PageId,
                        frame.DocumentId,
                        frame.Width,
                        frame.Height,
                        frame.Data,
                    }
                );
                await ack.Task.WaitAsync(TimeSpan.FromSeconds(15), lifetime.Token);
            }
        }
        async Task SendControlsAsync()
        {
            await foreach (var control in controls.Reader.ReadAllAsync(lifetime.Token))
            {
                await SendAsync(control);
            }
        }
        async Task ReceiveAsync()
        {
            var buffer = new byte[16384];
            while (!lifetime.IsCancellationRequested)
            {
                using var message = new MemoryStream();
                ValueWebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(buffer.AsMemory(), lifetime.Token);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        using var closing = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                        await sending.WaitAsync(closing.Token);
                        try
                        {
                            await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", closing.Token);
                        }
                        finally
                        {
                            sending.Release();
                        }
                        return;
                    }
                    if (result.MessageType != WebSocketMessageType.Text || message.Length + result.Count > 65536)
                    {
                        throw new IOException("Invalid viewer message.");
                    }
                    await message.WriteAsync(buffer.AsMemory(0, result.Count), lifetime.Token);
                } while (!result.EndOfMessage);
                string? dialogId = null;
                string? pickerId = null;
                try
                {
                    using var document = JsonDocument.Parse(
                        message.GetBuffer().AsMemory(0, checked((int)message.Length))
                    );
                    var root = document.RootElement;
                    if (
                        root.GetProperty("type").GetString() == "dialog"
                        && root.TryGetProperty("dialogId", out var dialog)
                    )
                    {
                        dialogId = dialog.GetString();
                    }
                    if (
                        root.GetProperty("type").GetString() == "select"
                        && root.TryGetProperty("pickerId", out var picker)
                    )
                    {
                        pickerId = picker.GetString();
                    }
                    if (root.GetProperty("type").GetString() == "ack")
                    {
                        if (root.GetProperty("frameId").GetInt64() == Interlocked.Read(ref frameId))
                        {
                            Volatile.Read(ref acknowledgment)?.TrySetResult();
                        }
                        continue;
                    }
                    if (!inputs.Writer.TryWrite(root.Clone()))
                    {
                        throw new IOException("The viewer input queue is full.");
                    }
                }
                catch (Exception error)
                    when (error
                            is ApiException
                                or CdpException
                                or JsonException
                                or InvalidOperationException
                                or KeyNotFoundException
                                or FormatException
                    )
                {
                    await ReportErrorAsync(error, dialogId, pickerId);
                }
            }
        }
        async Task ProcessInputsAsync()
        {
            await foreach (var input in inputs.Reader.ReadAllAsync(lifetime.Token))
            {
                try
                {
                    await handleInput(input, lifetime.Token);
                }
                catch (Exception error)
                    when (error
                            is ApiException
                                or CdpException
                                or JsonException
                                or InvalidOperationException
                                or KeyNotFoundException
                                or FormatException
                    )
                {
                    string? ReadId(string name) =>
                        input.TryGetProperty(name, out var id) && id.ValueKind == JsonValueKind.String
                            ? id.GetString()
                            : null;
                    await ReportErrorAsync(error, ReadId("dialogId"), ReadId("pickerId"));
                }
            }
        }
        Task ReportErrorAsync(Exception error, string? dialogId, string? pickerId) =>
            SendAsync(
                new
                {
                    type = "error",
                    code = error is ApiException api ? api.Code
                    : error is CdpException ? "browser_operation_failed"
                    : "invalid_viewer_input",
                    message = error is ApiException known ? known.Message
                    : error is CdpException ? "The browser could not complete this interaction."
                    : "The viewer input is invalid.",
                    dialogId,
                    pickerId,
                }
            );
        var tasks = new[] { SendFramesAsync(), SendControlsAsync(), ReceiveAsync(), ProcessInputsAsync() };
        await Task.WhenAny(tasks);
        await lifetime.CancelAsync();
        if (socket.State != WebSocketState.Closed)
        {
            socket.Abort();
        }
        try
        {
            await Task.WhenAll(tasks);
        }
        catch (Exception error)
            when (error is OperationCanceledException or WebSocketException or IOException or TimeoutException) { }
    }
}
