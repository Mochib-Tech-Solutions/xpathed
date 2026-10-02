using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Xpathed.ClientApi.IntegrationTests;

public sealed class ResolverHandler : HttpMessageHandler
{
    public bool Fail { get; set; }
    public bool Wait { get; set; }
    public bool InvalidIdentity { get; set; }
    public bool MissingDiagnostics { get; set; }
    public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken
    )
    {
        Started.TrySetResult();
        if (Wait)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        }
        if (Fail)
        {
            throw new HttpRequestException("private upstream detail must not be logged");
        }
        var body = await request.Content!.ReadFromJsonAsync<JsonElement>(cancellationToken);
        var attempt = request.Headers.TryGetValues("X-Xpathed-Attempt-Id", out var ids)
            ? ids.Single()
            : Guid.NewGuid().ToString("N");
        var result = new
        {
            contractVersion = body.GetProperty("contractVersion").GetString(),
            outcome = "not_found",
            sessionId = "session-1",
            pageId = InvalidIdentity ? "wrong-page" : request.RequestUri!.Segments[^2].Trim('/'),
            documentId = body.GetProperty("documentId").GetString(),
            captureId = "capture-1",
            frameId = "main",
            traceId = "trace-1",
            attemptId = attempt,
            configurationId = "configuration-1",
            action = "click",
            target = (object?)null,
            diagnostics = MissingDiagnostics
                ? null
                : new
                {
                    stage = "complete",
                    modelCalls = 1,
                    usage = new { cost = 0.0001m },
                },
            actions = new[]
            {
                new
                {
                    actionId = "a1",
                    order = 1,
                    step = 1,
                    instruction = body.GetProperty("instruction").GetString(),
                    action = "click",
                    outcome = "not_found",
                    attemptId = attempt,
                },
            },
            summary = new { complete = true },
            inspectedActionId = (string?)null,
        };
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = JsonContent.Create(
                request.RequestUri!.AbsolutePath.StartsWith("/internal/", StringComparison.Ordinal)
                    ? (object)
                        new
                        {
                            result,
                            evidence = new
                            {
                                version = "1",
                                availability = "available",
                                instruction = "Click Save",
                                modelInput = "{\"candidates\":[]}",
                            },
                        }
                    : result
            ),
        };
    }
}
