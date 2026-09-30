using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace Xpathed.Resolver.Tests;

internal sealed class DeterministicServicesHandler : HttpMessageHandler
{
    private static readonly string[] SaveXpaths = ["//*[@data-testid='save-profile']"];
    public Func<string, CancellationToken, Task>? BeforeRespondAsync { get; init; }
    public string? ProviderBody { get; init; }
    public HttpStatusCode ProviderStatus { get; init; } = HttpStatusCode.OK;
    public string PricingBody { get; init; } =
        """
            {"data":{"endpoints":[{"provider_name":"Wafer","tag":"wafer","pricing":{"prompt":"0.0000000749","completion":"0.00000044"}}]}}
            """;
    public HttpStatusCode PricingStatus { get; init; } = HttpStatusCode.OK;

    public string CaptureBody { get; init; } =
        """
            {"sessionId":"session-1","pageId":"page-1","documentId":"document-1","captureId":"capture-1","frameId":"main",
             "candidates":[{"id":"button-save","tag":"button","role":"button","text":"Save","label":"Save","placeholder":"","scope":["Profile"],
              "state":{"rendered":true,"inViewport":true,"enabled":true,"editable":false,"checked":null},"geometry":{"x":20,"y":40,"width":90,"height":30}}],
             "capturedAt":"2026-09-29T00:00:00Z","coverage":{"scannedCount":4,"eligibleCount":1,"capturedCount":1,"complete":true,"errorCode":null},"unsupportedBoundaryCount":0}
            """;
    public HttpStatusCode SelectionStatus { get; init; } = HttpStatusCode.OK;
    public string? SelectionBody { get; init; }
    public JsonElement ModelRequest { get; private set; }
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
            return Json(CaptureBody);
        }
        if (path == "/api/v1/chat/completions")
        {
            ProviderRequestCount++;
            ModelRequest = await request.Content!.ReadFromJsonAsync<JsonElement>(cancellationToken);
            return Json(
                ProviderBody
                    ?? """
                    {"id":"generation-1","model":"deepseek/deepseek-v4.1-flash","provider":"Wafer","service_tier":"default",
                     "choices":[{"finish_reason":"stop","message":{"content":"{\"outcome\":\"found\",\"action\":\"click\",\"candidateId\":\"button-save\"}"}}],
                     "usage":{"prompt_tokens":140,"completion_tokens":15,"total_tokens":155,"cost":0.0000215,"completion_tokens_details":{"reasoning_tokens":0}}}
                    """,
                ProviderStatus
            );
        }
        if (path == "/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints")
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
                                        ? (object?)null
                                        : new
                                        {
                                            candidateId = "button-save",
                                            tag = "button",
                                            label = "Save",
                                            xpaths = SaveXpaths,
                                            state = new
                                            {
                                                rendered = true,
                                                inViewport = true,
                                                enabled = true,
                                                editable = false,
                                                @checked = (bool?)null,
                                            },
                                            geometry = new
                                            {
                                                x = 20,
                                                y = 40,
                                                width = 90,
                                                height = 30,
                                            },
                                        },
                                }),
                            inspectedActionId = batch
                                .GetProperty("actions")
                                .EnumerateArray()
                                .Where(item => item.GetProperty("candidateId").ValueKind == JsonValueKind.String)
                                .Select(item => item.GetProperty("actionId").GetString())
                                .FirstOrDefault(),
                        }
                    )
            );
        }
        if (path == "/pages/page-1/selection")
        {
            SelectionRequestCount++;
            if (SelectionStatus != HttpStatusCode.OK)
            {
                return Json(
                    SelectionBody
                        ?? """{"code":"stale_document","message":"The page changed.","traceId":"browser-trace"}""",
                    SelectionStatus
                );
            }
            var selection = await request.Content!.ReadFromJsonAsync<JsonElement>(cancellationToken);
            if (selection.GetProperty("candidateId").ValueKind == JsonValueKind.Null)
            {
                return Json("""{"target":null}""");
            }
            Assert.Equal("button-save", selection.GetProperty("candidateId").GetString());
            Assert.Equal("capture-1", selection.GetProperty("captureId").GetString());
            Assert.Equal("document-1", selection.GetProperty("documentId").GetString());
            Assert.Equal("click", selection.GetProperty("action").GetString());
            return Json(
                SelectionBody
                    ?? """
                    {"target":{"candidateId":"button-save","tag":"button","label":"Save","xpaths":["//*[@data-testid='save-profile']"],
                     "state":{"rendered":true,"inViewport":true,"enabled":true,"editable":false,"checked":null},"geometry":{"x":20,"y":40,"width":90,"height":30}}}
                    """
            );
        }
        return new HttpResponseMessage(HttpStatusCode.NotFound);
    }

    private static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
}
