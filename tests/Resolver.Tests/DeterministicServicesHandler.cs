using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xpathed.Common.Contracts;

namespace Xpathed.Resolver.Tests;

internal sealed class DeterministicServicesHandler : HttpMessageHandler
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    public Func<string, CancellationToken, Task>? BeforeRespondAsync { get; init; }
    public string? ProviderBody { get; set; }
    public HttpStatusCode ProviderStatus { get; init; } = HttpStatusCode.OK;
    public string RouterBody { get; init; } = RouterResponse(0.01, 0.01);
    public HttpStatusCode RouterStatus { get; init; } = HttpStatusCode.OK;
    public string ImageBody { get; init; } =
        """{"sessionId":"session-1","pageId":"page-1","documentId":"document-1","captureId":"capture-1","image":{"png":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPz8AAAAASUVORK5CYII=","width":1,"height":1}}""";
    public HttpStatusCode ImageStatus { get; init; } = HttpStatusCode.OK;
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
    public string? XPathEvidenceBody { get; init; }
    public JsonElement ModelRequest { get; private set; }
    public JsonElement CaptureRequest { get; private set; }
    public JsonElement RouterRequest { get; private set; }
    public JsonElement ImageRequest { get; private set; }
    public int RouterRequestCount { get; private set; }
    public int ImageRequestCount { get; private set; }
    public int CaptureRequestCount { get; private set; }
    public int SelectionRequestCount { get; private set; }
    public int ProviderRequestCount { get; private set; }
    public int XPathEvidenceRequestCount { get; private set; }
    public JsonElement SelectionRequest { get; private set; }

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
            CaptureRequestCount++;
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
        if (path == "/api/alpha/decisions")
        {
            RouterRequestCount++;
            RouterRequest = await request.Content!.ReadFromJsonAsync<JsonElement>(cancellationToken);
            return Json(RouterBody, RouterStatus);
        }
        if (path == "/pages/page-1/capture-image")
        {
            ImageRequestCount++;
            ImageRequest = await request.Content!.ReadFromJsonAsync<JsonElement>(cancellationToken);
            return Json(ImageBody, ImageStatus);
        }
        if (
            path.StartsWith("/api/v1/models/", StringComparison.Ordinal)
            && path.EndsWith("/endpoints", StringComparison.Ordinal)
        )
        {
            return Json(PricingBody, PricingStatus);
        }
        if (path == "/pages/page-1/xpath-evidence")
        {
            XPathEvidenceRequestCount++;
            var requestBody = await request.Content!.ReadFromJsonAsync<XPathEvidenceRequest>(cancellationToken);
            return Json(
                XPathEvidenceBody ?? JsonSerializer.Serialize(Evidence(requestBody!.CandidateIds), JsonOptions)
            );
        }
        if (path == "/pages/page-1/selections")
        {
            SelectionRequestCount++;
            var batch = await request.Content!.ReadFromJsonAsync<JsonElement>(cancellationToken);
            SelectionRequest = batch.Clone();
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

    private XPathEvidenceBatch Evidence(string[] candidateIds)
    {
        var capture = JsonSerializer.Deserialize<CandidateCapture>(CaptureBody, JsonOptions)!;
        var nodes = new Dictionary<string, XPathNodeEvidence>(StringComparer.Ordinal);
        var targets = new List<XPathTargetEvidence>();
        void Context(string id, string[]? hosts = null)
        {
            nodes.TryAdd(
                id,
                new(
                    id,
                    null,
                    "iframe",
                    "http://www.w3.org/1999/xhtml",
                    new() { ["data-testid"] = id },
                    "",
                    [],
                    0,
                    false,
                    null,
                    1,
                    1,
                    null,
                    [],
                    [],
                    hosts ?? []
                )
            );
        }
        void Hosts(ShadowHost[]? hosts)
        {
            if (hosts is null)
            {
                return;
            }
            for (var index = 0; index < hosts.Length; index++)
            {
                Context(hosts[index].NodeId!, hosts.Take(index).Select(host => host.NodeId!).ToArray());
            }
        }
        foreach (var candidateId in candidateIds)
        {
            var candidate = capture.Candidates.Single(candidate => candidate.Id == candidateId);
            var id = "node:" + candidateId;
            targets.Add(new(candidateId, id, candidate.Frame, candidate.ShadowChain));
            nodes.Add(
                id,
                new(
                    id,
                    candidateId,
                    "button",
                    "http://www.w3.org/1999/xhtml",
                    new() { ["data-testid"] = "save-profile", ["id"] = "confirm" },
                    candidate.Text,
                    [],
                    0,
                    false,
                    null,
                    1,
                    1,
                    null,
                    [],
                    [],
                    (candidate.ShadowChain ?? []).Select(host => host.NodeId!).ToArray()
                )
            );
            Hosts(candidate.ShadowChain);

            foreach (var owner in candidate.Frame?.Chain ?? [])
            {
                Hosts(owner.ShadowChain);
                Context(owner.NodeId!, (owner.ShadowChain ?? []).Select(host => host.NodeId!).ToArray());
            }
        }
        return new("browser-evidence", [.. nodes.Values], [.. nodes.Keys], [.. targets]);
    }

    internal static JsonObject VerifiedTarget(string action = "click")
    {
        var target = JsonNode
            .Parse(
                """
                {"candidateId":"button-save","tag":"button","label":"Save","xpaths":["//*[@data-testid='save-profile']"],
                 "state":{"accessibilityExposed":true,"rendered":true,"inViewport":true,"enabled":true,"editable":false,"readonly":false,"checked":null},
                 "geometry":{"x":20,"y":40,"width":90,"height":30},
                 "interactability":{"action":"click","status":"ready","reasons":[],"checks":{"compatibleControl":"pass","enabled":"pass","writable":"not_applicable","viewport":"pass","pointerReception":"pass","keyboard":"not_applicable","stability":"unknown","eventOutcome":"unknown"}}}
                """
            )!
            .AsObject();
        target["interactability"]!["action"] = action;
        return target;
    }

    private static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    internal static string RouterResponse(double pixels, double appearance) =>
        JsonSerializer.Serialize(
            new
            {
                id = "routing-1",
                model = "typesafe/jev-1.13-20260917",
                provider = "TypeSafe",
                answers = new
                {
                    pixel_content = new { type = "noul", noul = pixels },
                    rendered_appearance = new { type = "noul", noul = appearance },
                },
                usage = new
                {
                    input_tokens = 80,
                    output_tokens = 0,
                    total_tokens = 80,
                    cost = 0.00000336m,
                },
            }
        );

    internal static string CurrentViewCapture()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["scope"] = "current_view";
        capture["candidates"]![0]!["appearance"] = JsonNode.Parse(
            """{"backgroundColor":"rgb(255, 0, 0)","textColor":"rgb(0, 0, 0)","borderColor":null,"limitations":[]}"""
        );
        return capture.ToJsonString();
    }

    internal static string BilledSelection()
    {
        var response = JsonNode.Parse(
            """{"id":"generation-1","model":"deepseek/deepseek-v4.1-flash","provider":"Wafer","choices":[{"finish_reason":"stop","message":{}}],"usage":{"prompt_tokens":140,"completion_tokens":15,"total_tokens":155,"cost":0.0000215}}"""
        );
        response!["choices"]![0]!["message"]!["content"] =
            """{"complete":true,"actions":[{"step":1,"instruction":"Click Save","action":"click","outcome":"found","candidateId":"button-save","limitation":"none"}]}""";
        return response.ToJsonString();
    }

    internal static string ProviderSelection(string selection) =>
        JsonSerializer.Serialize(
            new
            {
                id = "generation-1",
                choices = new[] { new { finish_reason = "stop", message = new { content = selection } } },
            }
        );
}
