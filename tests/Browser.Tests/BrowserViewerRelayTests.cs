using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;
using Xpathed.Browser.Viewing;

namespace Xpathed.Browser.Tests;

public sealed class BrowserViewerRelayTests
{
    [Fact]
    public async Task PeerCloseCancelsBlockedInputAndDiscardsQueuedInput()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var admissions = 0;
        var dispatched = 0;
        await using var server = await StartAsync(socket =>
            RunAsync(
                socket,
                async (_, token) =>
                {
                    Interlocked.Increment(ref admissions);
                    started.TrySetResult();
                    await Task.Delay(Timeout.Infinite, token);
                    Interlocked.Increment(ref dispatched);
                },
                completed,
                timeout.Token
            )
        );
        using var client = new ClientWebSocket();
        await client.ConnectAsync(Address(server), timeout.Token);
        await SendAsync(client, new { type = "text", text = "first" }, timeout.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await SendAsync(client, new { type = "text", text = "queued" }, timeout.Token);
        await client.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", timeout.Token);

        await completed.Task.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.Equal(1, admissions);
        Assert.Equal(0, dispatched);
    }

    [Fact]
    public async Task ConnectionCancellationReachesBlockedInput()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var connection = new CancellationTokenSource();
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token, connection.Token);
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var canceled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var server = await StartAsync(socket =>
            RunAsync(
                socket,
                async (_, token) =>
                {
                    started.TrySetResult();
                    try
                    {
                        await Task.Delay(Timeout.Infinite, token);
                    }
                    catch (OperationCanceledException) when (token.IsCancellationRequested)
                    {
                        canceled.TrySetResult();
                        throw;
                    }
                },
                completed,
                lifetime.Token
            )
        );
        using var client = new ClientWebSocket();
        await client.ConnectAsync(Address(server), timeout.Token);
        await SendAsync(client, new { type = "text", text = "pending" }, timeout.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(2));

        await connection.CancelAsync();

        await canceled.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await completed.Task.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task FullInputQueueCancelsBlockedInputInsteadOfBlockingDisconnect()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var admissions = 0;
        await using var server = await StartAsync(socket =>
            RunAsync(
                socket,
                async (_, token) =>
                {
                    Interlocked.Increment(ref admissions);
                    started.TrySetResult();
                    await Task.Delay(Timeout.Infinite, token);
                },
                completed,
                timeout.Token
            )
        );
        using var client = new ClientWebSocket();
        await client.ConnectAsync(Address(server), timeout.Token);
        await SendAsync(client, new { type = "text", text = "pending" }, timeout.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        try
        {
            for (var index = 0; index < 65; index++)
            {
                await SendAsync(client, new { type = "text", text = "queued" }, timeout.Token);
            }
        }
        catch (WebSocketException) { }

        await completed.Task.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.Equal(1, admissions);
    }

    [Fact]
    public async Task InputStaysOrderedAndOwnsItsParsedMessage()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var received = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        List<string> observed = [];
        await using var server = await StartAsync(socket =>
            RunAsync(
                socket,
                async (message, token) =>
                {
                    if (observed.Count == 0)
                    {
                        started.TrySetResult();
                        await resume.Task.WaitAsync(token);
                    }
                    observed.Add(message.GetProperty("text").GetString()!);
                    if (observed.Count == 3)
                    {
                        received.TrySetResult();
                    }
                },
                completed,
                timeout.Token
            )
        );
        using var client = new ClientWebSocket();
        await client.ConnectAsync(Address(server), timeout.Token);
        await SendAsync(client, new { type = "text", text = "first" }, timeout.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await SendAsync(client, new { type = "text", text = "second" }, timeout.Token);
        await SendAsync(client, new { type = "text", text = "third" }, timeout.Token);
        resume.TrySetResult();

        await received.Task.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.Equal(["first", "second", "third"], observed);
        await client.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", timeout.Token);
        await completed.Task.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task ScrollBurstPreservesDistanceAndFrameAcksWithoutDisconnecting()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var relay = new BrowserViewerRelay();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var drained = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        double distance = 0;
        await using var server = await StartAsync(async socket =>
        {
            await relay.RunAsync(
                socket,
                async (input, token) =>
                {
                    if (input.GetProperty("type").GetString() == "text")
                    {
                        started.TrySetResult();
                        await resume.Task.WaitAsync(token);
                    }
                    else if (input.GetProperty("type").GetString() == "mouse")
                    {
                        distance += input.GetProperty("deltaY").GetDouble();
                    }
                    else
                    {
                        drained.TrySetResult();
                    }
                },
                timeout.Token
            );
            completed.TrySetResult();
        });
        using var client = new ClientWebSocket();
        await client.ConnectAsync(Address(server), timeout.Token);
        await SendAsync(client, new { type = "text", text = "busy" }, timeout.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        relay.Publish(new BrowserVideoFrame("page", "document", 1280, 800, "image"));
        var first = await ReceiveAsync(client, timeout.Token);
        for (var index = 0; index < 100; index++)
        {
            await SendAsync(
                client,
                new
                {
                    type = "mouse",
                    @event = "wheel",
                    pageId = "page",
                    documentId = "document",
                    x = 100,
                    y = 100,
                    button = "none",
                    buttons = 0,
                    modifiers = 0,
                    deltaX = 0,
                    deltaY = 10,
                },
                timeout.Token
            );
        }
        await SendAsync(client, new { type = "ack", frameId = first.GetProperty("frameId").GetInt64() }, timeout.Token);
        relay.Publish(new BrowserVideoFrame("page", "document", 1280, 800, "next"));
        var next = await ReceiveAsync(client, timeout.Token);
        Assert.Equal("next", next.GetProperty("data").GetString());
        await SendAsync(client, new { type = "ack", frameId = next.GetProperty("frameId").GetInt64() }, timeout.Token);
        await SendAsync(client, new { type = "done" }, timeout.Token);
        resume.TrySetResult();
        await drained.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal(1000, distance);
        await client.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", timeout.Token);
        await completed.Task.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task PointerBurstKeepsTheLatestPositionAndPreservesClickBarriers()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var relay = new BrowserViewerRelay();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var drained = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        List<(string Action, int X)> observed = [];
        await using var server = await StartAsync(async socket =>
        {
            await relay.RunAsync(
                socket,
                async (input, token) =>
                {
                    if (input.GetProperty("type").GetString() == "text")
                    {
                        started.TrySetResult();
                        await resume.Task.WaitAsync(token);
                    }
                    else if (input.GetProperty("type").GetString() == "mouse")
                    {
                        observed.Add((input.GetProperty("event").GetString()!, input.GetProperty("x").GetInt32()));
                    }
                    else
                    {
                        drained.TrySetResult();
                    }
                },
                timeout.Token
            );
            completed.TrySetResult();
        });
        using var client = new ClientWebSocket();
        await client.ConnectAsync(Address(server), timeout.Token);
        await SendAsync(client, new { type = "text", text = "busy" }, timeout.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        async Task Mouse(string action, int x) =>
            await SendAsync(
                client,
                new
                {
                    type = "mouse",
                    @event = action,
                    pageId = "page",
                    documentId = "document",
                    x,
                    y = 100,
                    button = action == "move" ? "none" : "left",
                    buttons = action == "down" ? 1 : 0,
                    modifiers = 0,
                },
                timeout.Token
            );
        for (var index = 0; index < 100; index++)
        {
            await Mouse("move", index);
        }
        await Mouse("down", 99);
        await Mouse("up", 99);
        for (var index = 100; index < 200; index++)
        {
            await Mouse("move", index);
        }
        await SendAsync(client, new { type = "done" }, timeout.Token);
        relay.Publish(new BrowserVideoFrame("page", "document", 1280, 800, "image"));
        var frame = await ReceiveAsync(client, timeout.Token);
        await SendAsync(client, new { type = "ack", frameId = frame.GetProperty("frameId").GetInt64() }, timeout.Token);
        relay.Publish(new BrowserVideoFrame("page", "document", 1280, 800, "next"));
        Assert.Equal("next", (await ReceiveAsync(client, timeout.Token)).GetProperty("data").GetString());
        resume.TrySetResult();
        await drained.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal([("move", 99), ("down", 99), ("up", 99), ("move", 199)], observed);
        await client.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", timeout.Token);
        await completed.Task.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task DelayedFrameAckKeepsTheConnectionAndResumesWithTheLatestFrame()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        using var relay = new BrowserViewerRelay();
        await using var server = await StartAsync(socket =>
            relay.RunAsync(socket, (_, _) => Task.CompletedTask, timeout.Token)
        );
        using var client = new ClientWebSocket();
        await client.ConnectAsync(Address(server), timeout.Token);
        relay.Publish(new BrowserVideoFrame("page", "document", 1280, 800, "first"));
        var first = await ReceiveAsync(client, timeout.Token);
        relay.Publish(new BrowserVideoFrame("page", "document", 1280, 800, "obsolete"));
        relay.Publish(new BrowserVideoFrame("page", "document", 1280, 800, "latest"));
        await Task.Delay(TimeSpan.FromSeconds(16), timeout.Token);
        await SendAsync(client, new { type = "ack", frameId = first.GetProperty("frameId").GetInt64() }, timeout.Token);
        Assert.Equal("latest", (await ReceiveAsync(client, timeout.Token)).GetProperty("data").GetString());
        await client.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", timeout.Token);
    }

    [Fact]
    public async Task CursorBurstKeepsLatestFeedbackWithoutOverflowingControls()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var relay = new BrowserViewerRelay();
        for (var index = 0; index < 100; index++)
        {
            relay.PublishCursor(new { type = "cursor", cursor = index });
        }
        await using var server = await StartAsync(socket =>
            relay.RunAsync(socket, (_, _) => Task.CompletedTask, timeout.Token)
        );
        using var client = new ClientWebSocket();
        await client.ConnectAsync(Address(server), timeout.Token);
        Assert.Equal(99, (await ReceiveAsync(client, timeout.Token)).GetProperty("cursor").GetInt32());
        relay.Publish(new BrowserVideoFrame("page", "document", 1280, 800, "first"));
        Assert.Equal("frame", (await ReceiveAsync(client, timeout.Token)).GetProperty("type").GetString());
        relay.PublishCursor(new { type = "cursor", cursor = "pointer" });
        Assert.Equal("pointer", (await ReceiveAsync(client, timeout.Token)).GetProperty("cursor").GetString());
        await client.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", timeout.Token);
    }

    private static async Task<JsonElement> ReceiveAsync(WebSocket socket, CancellationToken token)
    {
        using var message = new MemoryStream();
        var buffer = new byte[16384];
        ValueWebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(buffer.AsMemory(), token);
            Assert.Equal(WebSocketMessageType.Text, result.MessageType);
            await message.WriteAsync(buffer.AsMemory(0, result.Count), token);
        } while (!result.EndOfMessage);
        using var document = JsonDocument.Parse(message.ToArray());
        return document.RootElement.Clone();
    }

    private static async Task RunAsync(
        WebSocket socket,
        Func<JsonElement, CancellationToken, Task> handle,
        TaskCompletionSource completed,
        CancellationToken token
    )
    {
        using var relay = new BrowserViewerRelay();
        try
        {
            await relay.RunAsync(socket, handle, token);
            completed.TrySetResult();
        }
        catch (Exception error)
        {
            completed.TrySetException(error);
        }
    }

    private static async Task<WebApplication> StartAsync(Func<WebSocket, Task> handle)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var app = builder.Build();
        app.UseWebSockets();
        app.Run(async context =>
        {
            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            await handle(socket);
        });
        await app.StartAsync();
        return app;
    }

    private static Uri Address(WebApplication app) =>
        new(app.Urls.Single().Replace("http://", "ws://", StringComparison.Ordinal));

    private static Task SendAsync(WebSocket socket, object message, CancellationToken token) =>
        socket
            .SendAsync(JsonSerializer.SerializeToUtf8Bytes(message).AsMemory(), WebSocketMessageType.Text, true, token)
            .AsTask();
}
