using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using static Xpathed.Resolver.Tests.DeterministicServicesHandler;
using static Xpathed.Resolver.Tests.ResolverTestApplication;

namespace Xpathed.Resolver.Tests;

public sealed class ResolutionLifecycleTests
{
    [Theory]
    [InlineData("/pages/page-1/capture")]
    [InlineData("/api/v1/chat/completions")]
    [InlineData("/pages/page-1/selections")]
    public async Task CurrentViewResolutionCompletesBeyondTheTwoSecondLatencyTarget(string slowPath)
    {
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = BilledSelection(),
            BeforeRespondAsync = async (path, token) =>
            {
                if (path == slowPath)
                {
                    await Task.Delay(TimeSpan.FromMilliseconds(2100), token);
                }
            },
        };
        var result = await ResolveContextAsync(handler, "Click Save");
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.True(
            result.GetProperty("diagnostics").GetProperty("timingsMs").GetProperty("total").GetDouble() >= 2000
        );
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal(1, handler.SelectionRequestCount);
        Assert.Equal(
            0.0000215m,
            result.GetProperty("diagnostics").GetProperty("usage").GetProperty("cost").GetDecimal()
        );
    }

    [Fact]
    public async Task CurrentViewCallerCancellationStopsCaptureBeforeAnyProviderCall()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new DeterministicServicesHandler
        {
            BeforeRespondAsync = async (path, token) =>
            {
                if (!path.EndsWith("/capture", StringComparison.Ordinal))
                {
                    return;
                }
                try
                {
                    started.TrySetResult();
                    await Task.Delay(TimeSpan.FromSeconds(10), token);
                }
                catch (OperationCanceledException)
                {
                    cancelled.TrySetResult();
                    throw;
                }
            },
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var cancellation = new CancellationTokenSource();
        var request = client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                imageMode = "text_only",
            },
            cancellation.Token
        );
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => request);
        await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(1));
        Assert.Equal(0, handler.ProviderRequestCount);
        Assert.Equal(0, handler.SelectionRequestCount);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public async Task PublicResultsAndApiErrorsPreserveDistributedTraceIdentity(int failure)
    {
        await using var application = CreateApplication(new DeterministicServicesHandler());
        using var client = application.CreateClient();
        client.DefaultRequestHeaders.Add("traceparent", "00-0123456789abcdef0123456789abcdef-1234567890abcdef-01");
        if (failure == 1)
        {
            client.DefaultRequestHeaders.Add("Origin", "http://localhost:8080");
        }
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = failure == 2 ? "" : "Click Save",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(
            failure == 1 ? HttpStatusCode.Forbidden
                : failure == 2 ? HttpStatusCode.BadRequest
                : HttpStatusCode.OK,
            response.StatusCode
        );
        Assert.Equal("0123456789abcdef0123456789abcdef", body.GetProperty("traceId").GetString());
    }

    [Fact]
    public async Task PublicResolutionDoesNotExposeModelInputAndRejectsBrowserOrigins()
    {
        var handler = new DeterministicServicesHandler();
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.False(result.TryGetProperty("evidence", out _));
        Assert.False(result.TryGetProperty("modelInput", out _));
        Assert.False(result.TryGetProperty("systemPrompt", out _));
        Assert.DoesNotContain("test-token", result.GetRawText(), StringComparison.Ordinal);
        client.DefaultRequestHeaders.Add("Origin", "http://localhost:8080");
        using var blocked = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        Assert.Equal(HttpStatusCode.Forbidden, blocked.StatusCode);
        Assert.Equal(1, handler.ProviderRequestCount);
    }

    [Fact]
    public async Task RemovedEvidenceRouteDoesNotCallProvider()
    {
        var handler = new DeterministicServicesHandler();
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/internal/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(0, handler.CaptureRequestCount);
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    [Fact]
    public async Task PublicResolutionGeneratesFreshAttemptIdentities()
    {
        var handler = new DeterministicServicesHandler();
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        const string supplied = "0123456789abcdef0123456789abcdef";
        client.DefaultRequestHeaders.Add("X-Xpathed-Attempt-Id", supplied);
        var identities = new HashSet<string>();
        for (var attempt = 0; attempt < 2; attempt++)
        {
            using var response = await client.PostAsJsonAsync(
                "/pages/page-1/resolve",
                new
                {
                    instruction = "Click Save",
                    documentId = "document-1",
                    imageMode = "text_only",
                }
            );
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var result = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("found", result.GetProperty("outcome").GetString());
            var identity = result.GetProperty("attemptId").GetString()!;
            Assert.True(Guid.TryParseExact(identity, "N", out _));
            Assert.NotEqual(supplied, identity);
            Assert.True(identities.Add(identity));
        }
        Assert.Equal(2, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData("/api/v1/chat/completions", "provider_timeout")]
    [InlineData("/pages/page-1/capture", "browser_timeout")]
    [InlineData("/pages/page-1/selections", "browser_timeout")]
    public async Task UpstreamTimeoutsRemainOperationalErrors(string failedPath, string expectedCode)
    {
        var handler = new DeterministicServicesHandler
        {
            BeforeRespondAsync = (path, _) =>
                path == failedPath ? Task.FromException(new OperationCanceledException()) : Task.CompletedTask,
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal(expectedCode, result.GetProperty("diagnostics").GetProperty("code").GetString());
    }

    [Theory]
    [InlineData("/pages/page-1/capture")]
    [InlineData("/pages/page-1/selections")]
    [InlineData("/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints")]
    public async Task RequestCancellationReachesEveryUpstreamBoundary(string blockedPath)
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new DeterministicServicesHandler
        {
            BeforeRespondAsync = async (path, cancellationToken) =>
            {
                if (path != blockedPath)
                {
                    return;
                }
                started.SetResult();
                try
                {
                    await Task.Delay(Timeout.Infinite, cancellationToken);
                }
                finally
                {
                    cancelled.SetResult();
                }
            },
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var cancellation = new CancellationTokenSource();
        var response = client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                imageMode = "text_only",
            },
            cancellation.Token
        );
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await cancellation.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => response);
        await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("""{"instruction":" ","documentId":"document-1"}""")]
    [InlineData("""{"instruction":"Click Save","documentId":null}""")]
    [InlineData("{")]
    public async Task InvalidPublicRequestsReturnTheExistingBadRequestEnvelope(string body)
    {
        var handler = new DeterministicServicesHandler();
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
        using var response = await client.PostAsync("/pages/page-1/resolve", content);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("invalid_request", result.GetProperty("code").GetString());
        Assert.Equal(0, handler.ProviderRequestCount);
    }
}
