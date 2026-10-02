using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Xpathed.Resolver.Tests;

internal sealed class DeterministicServicesHandler : HttpMessageHandler
{
    public Func<string, CancellationToken, Task>? BeforeRespondAsync { get; init; }
    public string? ProviderBody { get; set; }
    public HttpStatusCode ProviderStatus { get; init; } = HttpStatusCode.OK;
    public string PricingBody { get; set; } =
        """
            {"data":{"endpoints":[{"provider_name":"Wafer","tag":"wafer","pricing":{"prompt":"0.0000000749","completion":"0.00000044"}}]}}
            """;
    public HttpStatusCode PricingStatus { get; init; } = HttpStatusCode.OK;

    public string CaptureBody { get; init; } =
        """
            {"sessionId":"session-1","pageId":"page-1","documentId":"document-1","captureId":"capture-1","frameId":"main",
             "candidates":[{"id":"button-save","tag":"button","role":"button","text":"Save","label":"Save","placeholder":"","scope":["Profile"],
              "state":{"rendered":true,"inViewport":true,"enabled":true,"editable":false,"checked":null},"geometry":{"x":20,"y":40,"width":90,"height":30},"appearance":{"backgroundColor":null,"textColor":null,"borderColor":null,"limitations":[]}}],
             "capturedAt":"2026-09-29T00:00:00Z","coverage":{"scannedCount":4,"eligibleCount":1,"capturedCount":1,"complete":true,"errorCode":null},"unsupportedBoundaryCount":0,"scope":"current_view"}
            """;
    public HttpStatusCode SelectionStatus { get; init; } = HttpStatusCode.OK;
    public string? SelectionBody { get; init; }
    public JsonElement ModelRequest { get; private set; }
    public JsonElement CaptureRequest { get; private set; }
    public int SelectionRequestCount { get; private set; }
    public int ProviderRequestCount { get; private set; }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken
    )
    {
        var path = request.RequestUri!.AbsolutePath;
        if (BeforeRespondAsync is not null)
        {
            await BeforeRespondAsync(path, cancellationToken);
        }
        if (path == "/pages/page-1/capture")
        {
            CaptureRequest = await request.Content!.ReadFromJsonAsync<JsonElement>(cancellationToken);
            return Json(CaptureBody);
        }
        if (path == "/api/v1/chat/completions")
        {
            ProviderRequestCount++;
            ModelRequest = await request.Content!.ReadFromJsonAsync<JsonElement>(cancellationToken);
            return Json(
                ProviderBody
                    ?? """{"id":"generation-1","model":"deepseek/deepseek-v4.1-flash","provider":"Wafer","service_tier":"default","choices":[{"finish_reason":"stop","message":{"content":"{\"complete\":true,\"actions\":[{\"step\":1,\"instruction\":\"Click Save\",\"outcome\":\"found\",\"action\":\"click\",\"candidateId\":\"button-save\",\"limitation\":\"none\"}]}"}}],"usage":{"prompt_tokens":140,"completion_tokens":15,"total_tokens":155,"cost":2.15e-05,"completion_tokens_details":{"reasoning_tokens":0}}}""",
                ProviderStatus
            );
        }
        if (
            path.StartsWith("/api/v1/models/", StringComparison.Ordinal)
            && path.EndsWith("/endpoints", StringComparison.Ordinal)
        )
        {
            return Json(PricingBody, PricingStatus);
        }
        if (path == "/pages/page-1/selections")
        {
            SelectionRequestCount++;
            var batch = await request.Content!.ReadFromJsonAsync<JsonElement>(cancellationToken);
            return Json(
                SelectionBody
                    ?? JsonSerializer.Serialize(
                        new
                        {
                            actions = batch
                                .GetProperty("actions")
                                .EnumerateArray()
                                .Select(item => new
                                {
                                    actionId = item.GetProperty("actionId").GetString(),
                                    target = item.GetProperty("candidateId").ValueKind == JsonValueKind.Null
                                        ? null
                                        : VerifiedTarget(item.GetProperty("action").GetString()!),
                                }),
                            inspectedActionId = batch
                                .GetProperty("actions")
                                .EnumerateArray()
                                .Where(item => item.GetProperty("candidateId").ValueKind == JsonValueKind.String)
                                .Select(item => item.GetProperty("actionId").GetString())
                                .FirstOrDefault(),
                        }
                    ),
                SelectionStatus
            );
        }
        return new HttpResponseMessage(HttpStatusCode.NotFound);
    }

    internal static JsonObject VerifiedTarget(string action = "click")
    {
        var target = JsonNode
            .Parse(
                """
                {"candidateId":"button-save","tag":"button","label":"Save","xpaths":["//*[@data-testid='save-profile']"],
                 "state":{"version":"2","accessibilityExposed":true,"rendered":true,"inViewport":true,"enabled":true,"editable":false,"readonly":false,"checked":null},
                 "geometry":{"x":20,"y":40,"width":90,"height":30},
                 "interactability":{"version":"2","action":"click","status":"ready","reasons":[],"checks":{"compatibleControl":"pass","enabled":"pass","writable":"not_applicable","viewport":"pass","pointerReception":"pass","keyboard":"not_applicable","stability":"unknown","eventOutcome":"unknown"}}}
                """
            )!
            .AsObject();
        target["interactability"]!["action"] = action;
        return target;
    }

    private static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
}
