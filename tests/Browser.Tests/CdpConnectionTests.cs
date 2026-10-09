using System.IO.Pipelines;
using System.Text;
using System.Text.Json;
using Xpathed.Browser.Protocol;

namespace Xpathed.Browser.Tests;

public sealed class CdpConnectionTests
{
    [Fact]
    public async Task MatchesOutOfOrderResponsesAndKeepsFlatSessionIdentifiers()
    {
        await using var pipe = new PipeFixture();
        var first = pipe.Connection.SendAsync("Target.getTargets");
        var second = pipe.Connection.SendAsync("Runtime.evaluate", new { expression = "1+1" }, "frame-session");
        var firstRequest = await pipe.ReceiveAsync();
        var secondRequest = await pipe.ReceiveAsync();
        Assert.False(firstRequest.TryGetProperty("sessionId", out _));
        Assert.Equal("frame-session", secondRequest.GetProperty("sessionId").GetString());
        await pipe.SendAsync(new { id = secondRequest.GetProperty("id").GetInt64(), result = new { value = 2 } });
        await pipe.SendAsync(new { id = firstRequest.GetProperty("id").GetInt64(), result = new { value = 1 } });
        Assert.Equal(1, (await first).GetProperty("value").GetInt32());
        Assert.Equal(2, (await second).GetProperty("value").GetInt32());
    }

    [Fact]
    public async Task ProtocolErrorsNeverExposeBrowserSuppliedMessages()
    {
        await using var pipe = new PipeFixture();
        var command = pipe.Connection.SendAsync("Runtime.evaluate");
        var request = await pipe.ReceiveAsync();
        await pipe.SendAsync(
            new
            {
                id = request.GetProperty("id").GetInt64(),
                error = new { code = -1, message = "SYNTHETIC_PRIVATE_VALUE" },
            }
        );
        var error = await Assert.ThrowsAsync<CdpException>(() => command);
        Assert.DoesNotContain("SYNTHETIC_PRIVATE_VALUE", error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task DisconnectEndsOutstandingCommandsAndDisposeIsIdempotent()
    {
        await using var pipe = new PipeFixture();
        var command = pipe.Connection.SendAsync("Runtime.evaluate");
        await pipe.ReceiveAsync();
        await pipe.BrowserOutput.DisposeAsync();
        var error = await Assert.ThrowsAnyAsync<Exception>(() => command.WaitAsync(TimeSpan.FromSeconds(2)));
        Assert.IsNotType<TimeoutException>(error);
        await pipe.Connection.DisposeAsync();
        await pipe.Connection.DisposeAsync();
        await Assert.ThrowsAsync<CdpException>(() => pipe.Connection.SendAsync("Page.navigate"));
    }

    [Fact]
    public async Task RetainedObjectRejectsReusedContextAndReleasesOnlyItsIssuingSession()
    {
        await using var pipe = new PipeFixture();
        var page = new CdpPage(pipe.Connection, "target", "root", new("1024x768", 1024, 768));
        var context = new CdpContext("original-session", 1, "unique-original");
        var frame = new CdpFrame(page, "frame", context.SessionId) { Context = context };
        var retained = new CdpRemoteObject(frame, "object", context);
        frame.SessionId = "replacement-session";
        frame.Context = new("replacement-session", 1, "unique-replacement");
        await Assert.ThrowsAsync<CdpException>(() => retained.EvaluateAsync<bool>("element => element.isConnected"));
        var release = retained.DisposeAsync().AsTask();
        var request = await pipe.ReceiveAsync();
        Assert.Equal("Runtime.releaseObject", request.GetProperty("method").GetString());
        Assert.Equal("original-session", request.GetProperty("sessionId").GetString());
        await pipe.SendAsync(new { id = request.GetProperty("id").GetInt64(), result = new { } });
        await release;
    }

    [Fact]
    public async Task GlobalEvaluationUsesProcessUniqueContextIdentity()
    {
        await using var pipe = new PipeFixture();
        var page = new CdpPage(pipe.Connection, "target", "session", new("1024x768", 1024, 768));
        var frame = new CdpFrame(page, "frame", "session") { Context = new("session", 1, "unique-document") };
        var evaluation = frame.EvaluateAsync<bool>("true");
        var request = await pipe.ReceiveAsync();
        var parameters = request.GetProperty("params");
        Assert.Equal("unique-document", parameters.GetProperty("uniqueContextId").GetString());
        Assert.False(parameters.TryGetProperty("contextId", out _));
        await pipe.SendAsync(
            new { id = request.GetProperty("id").GetInt64(), result = new { result = new { value = true } } }
        );
        Assert.True(await evaluation);
    }

    [Fact]
    public async Task DeepProtocolFrameTreesDoNotDisconnectTheManagedBrowser()
    {
        await using var pipe = new PipeFixture();
        var command = pipe.Connection.SendAsync("Page.getFrameTree");
        var request = await pipe.ReceiveAsync();
        var tree = "{}";
        for (var index = 0; index < 100; index++)
        {
            tree = "{\"child\":" + tree + "}";
        }
        await pipe.SendBytesAsync(
            Encoding.UTF8.GetBytes("{\"id\":" + request.GetProperty("id").GetRawText() + ",\"result\":" + tree + "}\0")
        );
        var result = await command.WaitAsync(TimeSpan.FromSeconds(2));
        var depth = 0;
        while (result.TryGetProperty("child", out var child))
        {
            depth++;
            result = child;
        }
        Assert.Equal(100, depth);
    }

    [Fact]
    public async Task FragmentedUtf8AndCoalescedMessagesPreserveProtocolBoundaries()
    {
        await using var pipe = new PipeFixture();
        var events = new List<string>();
        var received = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        pipe.Connection.Event += (session, method, data) =>
        {
            Assert.Equal("session", session);
            Assert.Equal("Runtime.bindingCalled", method);
            events.Add(data.GetProperty("value").GetString()!);
            if (events.Count == 2)
            {
                received.TrySetResult();
            }
        };
        var bytes = Encoding.UTF8.GetBytes(
            "{\"sessionId\":\"session\",\"method\":\"Runtime.bindingCalled\",\"params\":{\"value\":\"é😊\"}}\0"
                + "{\"sessionId\":\"session\",\"method\":\"Runtime.bindingCalled\",\"params\":{\"value\":\"second\"}}\0"
        );
        var split = Array.IndexOf(bytes, (byte)0xf0) + 2;
        await pipe.SendBytesAsync(bytes.AsMemory(0, split));
        await pipe.SendBytesAsync(bytes.AsMemory(split));
        await received.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal(["é😊", "second"], events);
    }

    [Fact]
    public async Task DisposeInterruptsBlockedPipeReadAndPendingResponse()
    {
        await using var pipe = new PipeFixture();
        var command = pipe.Connection.SendAsync("Target.getTargets");
        await pipe.ReceiveAsync();
        await pipe.Connection.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(2));
        var error = await Assert.ThrowsAnyAsync<Exception>(() => command.WaitAsync(TimeSpan.FromSeconds(2)));
        Assert.IsNotType<TimeoutException>(error);
    }

    [Fact]
    public async Task DisposeWaitsForCanceledWriterBeforeDisposingItsSendLock()
    {
        var incoming = new Pipe();
        await using var writer = new DelayedCancellationStream();
        await using var connection = new CdpConnection();
        connection.Connect(incoming.Reader.AsStream(), writer);
        var command = connection.SendAsync("Target.getTargets");
        await writer.Started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        var queued = connection.SendAsync("Page.navigate");
        var disposal = connection.DisposeAsync().AsTask();
        try
        {
            await writer.Canceled.Task.WaitAsync(TimeSpan.FromSeconds(2));
            Assert.False(disposal.IsCompleted);
        }
        finally
        {
            writer.Resume.TrySetResult();
        }
        await disposal.WaitAsync(TimeSpan.FromSeconds(2));
        var writeError = await Assert.ThrowsAnyAsync<Exception>(() => command.WaitAsync(TimeSpan.FromSeconds(2)));
        var queuedError = await Assert.ThrowsAnyAsync<Exception>(() => queued.WaitAsync(TimeSpan.FromSeconds(2)));
        Assert.IsNotType<ObjectDisposedException>(writeError);
        Assert.IsNotType<TimeoutException>(writeError);
        Assert.IsNotType<ObjectDisposedException>(queuedError);
        Assert.IsNotType<TimeoutException>(queuedError);
        await incoming.Writer.CompleteAsync();
    }

    [Fact]
    public async Task RejectedSendGuardWritesNoCommandAndKeepsConnectionUsable()
    {
        await using var pipe = new PipeFixture();
        await Assert.ThrowsAsync<CdpException>(() =>
            pipe.Connection.SendAsync(
                "Input.insertText",
                new { text = "must-not-dispatch" },
                beforeSend: () => throw new CdpException("The displayed document changed.")
            )
        );
        var next = pipe.Connection.SendAsync("Target.getTargets");
        var request = await pipe.ReceiveAsync();
        Assert.Equal("Target.getTargets", request.GetProperty("method").GetString());
        await pipe.SendAsync(new { id = request.GetProperty("id").GetInt64(), result = new { } });
        await next.WaitAsync(TimeSpan.FromSeconds(2));
    }

    private sealed class DelayedCancellationStream : Stream
    {
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Canceled { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Resume { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Flush() { }

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override async ValueTask WriteAsync(
            ReadOnlyMemory<byte> buffer,
            CancellationToken cancellationToken = default
        )
        {
            Started.TrySetResult();
            try
            {
                await Task.Delay(Timeout.Infinite, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                Canceled.TrySetResult();
                await Resume.Task;
                throw;
            }
        }
    }

    private sealed class PipeFixture : IAsyncDisposable
    {
        private readonly Stream browserInput;
        public Stream BrowserOutput { get; }
        public CdpConnection Connection { get; } = new();

        public PipeFixture()
        {
            var incoming = new Pipe();
            var outgoing = new Pipe();
            browserInput = outgoing.Reader.AsStream();
            BrowserOutput = incoming.Writer.AsStream();
            Connection.Connect(incoming.Reader.AsStream(), outgoing.Writer.AsStream());
        }

        public async Task<JsonElement> ReceiveAsync()
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            using var message = new MemoryStream();
            var value = new byte[1];
            while (await browserInput.ReadAsync(value, timeout.Token) != 0)
            {
                if (value[0] == 0)
                {
                    using var document = JsonDocument.Parse(message.ToArray());
                    return document.RootElement.Clone();
                }
                message.WriteByte(value[0]);
            }
            throw new EndOfStreamException();
        }

        public Task SendAsync(object message) =>
            SendBytesAsync(JsonSerializer.SerializeToUtf8Bytes(message).Concat(new byte[] { 0 }).ToArray());

        public async Task SendBytesAsync(ReadOnlyMemory<byte> bytes)
        {
            await BrowserOutput.WriteAsync(bytes);
            await BrowserOutput.FlushAsync();
        }

        public async ValueTask DisposeAsync()
        {
            await Connection.DisposeAsync();
            await browserInput.DisposeAsync();
            await BrowserOutput.DisposeAsync();
        }
    }
}
