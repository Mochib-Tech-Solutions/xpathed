using System.Net.WebSockets;

namespace Xpathed.Browser.Viewing;

internal static class VncRelay
{
    public static async Task RelayAsync(WebSocket socket, Stream stream, CancellationToken cancellationToken)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        async Task FromViewer()
        {
            var buffer = new byte[16384];
            while (!lifetime.IsCancellationRequested)
            {
                var result = await socket.ReceiveAsync(buffer.AsMemory(), lifetime.Token);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    return;
                }

                if (result.MessageType != WebSocketMessageType.Binary)
                {
                    throw new IOException("Binary VNC data required.");
                }

                await stream.WriteAsync(buffer.AsMemory(0, result.Count), lifetime.Token);
            }
        }
        async Task ToViewer()
        {
            var buffer = new byte[16384];
            int count;
            while ((count = await stream.ReadAsync(buffer, lifetime.Token)) > 0)
            {
                await socket.SendAsync(buffer.AsMemory(0, count), WebSocketMessageType.Binary, true, lifetime.Token);
            }
        }
        var sending = FromViewer();
        var receiving = ToViewer();
        await Task.WhenAny(sending, receiving);
        await lifetime.CancelAsync();
        try
        {
            await Task.WhenAll(sending, receiving);
        }
        catch (Exception error) when (error is OperationCanceledException or WebSocketException or IOException) { }
        if (socket.State == WebSocketState.CloseReceived)
        {
            using var closing = new CancellationTokenSource(TimeSpan.FromSeconds(1));
            try
            {
                await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, closing.Token);
            }
            catch (Exception error) when (error is OperationCanceledException or WebSocketException or IOException) { }
        }
        socket.Abort();
    }
}
