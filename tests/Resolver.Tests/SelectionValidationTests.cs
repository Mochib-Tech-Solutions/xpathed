using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using static Xpathed.Resolver.Tests.DeterministicServicesHandler;
using static Xpathed.Resolver.Tests.ResolverTestApplication;

namespace Xpathed.Resolver.Tests;

public sealed class SelectionValidationTests
{
    [Theory]
    [InlineData("not_found", "click", "none", "No matching element found in the current view.")]
    [InlineData(
        "unsupported",
        "click",
        "current_state_dependency",
        "This command requires separate steps or a page change. No action was executed."
    )]
    public async Task CurrentViewMissingAndFutureStateOutcomesRemainDistinct(
        string outcome,
        string action,
        string limitation,
        string message
    )
    {
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = ProviderSelection(
                JsonSerializer.Serialize(
                    new
                    {
                        complete = true,
                        actions = new[]
                        {
                            new
                            {
                                step = 1,
                                instruction = "Click Help",
                                action,
                                outcome,
                                candidateId = (string?)null,
                                limitation,
                            },
                        },
                    }
                )
            ),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = limitation == "none" ? "Click Help" : "Scroll down and click Help",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(outcome, result.GetProperty("outcome").GetString());
        Assert.Equal(message, result.GetProperty("actions")[0].GetProperty("message").GetString());
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal(1, handler.SelectionRequestCount);
    }

    [Theory]
    [InlineData("found")]
    [InlineData("not_found")]
    public async Task ChangedCurrentViewIsAnErrorInsteadOfAFoundOrMissingTarget(string outcome)
    {
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = ProviderSelection(
                JsonSerializer.Serialize(
                    new
                    {
                        complete = true,
                        actions = new[]
                        {
                            new
                            {
                                step = 1,
                                instruction = "Click Save",
                                action = "click",
                                outcome,
                                candidateId = outcome == "found" ? "button-save" : null,
                                limitation = "none",
                            },
                        },
                    }
                )
            ),
            SelectionStatus = HttpStatusCode.Conflict,
            SelectionBody = """{"code":"stale_capture"}""",
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
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Empty(result.GetProperty("actions").EnumerateArray());
        Assert.Equal("stale_capture", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(
            "The page or current view changed. Resolve the instruction again.",
            result.GetProperty("diagnostics").GetProperty("message").GetString()
        );
        Assert.Equal(1, handler.SelectionRequestCount);
    }

    [Fact]
    public async Task ANullBrowserActionIsAnOperationalErrorRatherThanAnUnhandledFailure()
    {
        var handler = new DeterministicServicesHandler
        {
            ProviderBody = ProviderSelection(
                """
                {"complete":true,"actions":[{"step":1,"instruction":"Click Save","outcome":"found","action":"click","candidateId":"button-save","limitation":"none"}]}
                """
            ),
            SelectionBody = """{"actions":[null],"inspectedActionId":null}""",
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
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal("invalid_browser_selection", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Empty(result.GetProperty("actions").EnumerateArray());
    }

    [Fact]
    public async Task OneInteractionPreservesFoundAndMissingTargetsWithSharedAction()
    {
        var handler = new DeterministicServicesHandler
        {
            ProviderBody = ProviderSelection(
                """
                {"complete":true,"actions":[
                  {"step":1,"instruction":"Click Save","outcome":"found","action":"click","candidateId":"button-save","limitation":"none"},
                  {"step":2,"instruction":"Click Contact","outcome":"not_found","action":"click","candidateId":null,"limitation":"none"}]}
                """
            ),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save and Contact",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("click", result.GetProperty("action").GetString());
        Assert.Equal("partial", result.GetProperty("outcome").GetString());
        Assert.Equal(2, result.GetProperty("actions").GetArrayLength());
        Assert.Equal(
            "button-save",
            result.GetProperty("actions")[0].GetProperty("target").GetProperty("candidateId").GetString()
        );
        Assert.Equal("not_found", result.GetProperty("actions")[1].GetProperty("outcome").GetString());
        Assert.Equal(1, result.GetProperty("summary").GetProperty("found").GetInt32());
        Assert.Equal(1, result.GetProperty("summary").GetProperty("notFound").GetInt32());
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal(1, handler.SelectionRequestCount);
    }

    [Theory]
    [InlineData("not_found", "click", 0, "not_found")]
    [InlineData("not_found", "click", 1, "unsupported")]
    [InlineData("unsupported", "unsupported", 0, "unsupported")]
    public async Task SemanticAbsenceAndUnsupportedResultsValidateTheCurrentCapture(
        string outcome,
        string action,
        int boundaries,
        string expected
    )
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["unsupportedBoundaryCount"] = boundaries;
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = capture.ToJsonString(),
            ProviderBody = ProviderSelection(
                JsonSerializer.Serialize(
                    new
                    {
                        complete = true,
                        actions = new[]
                        {
                            new
                            {
                                step = 1,
                                instruction = "Click Save",
                                outcome,
                                action,
                                candidateId = (string?)null,
                                limitation = outcome == "unsupported" ? "unsupported_action" : "none",
                            },
                        },
                    }
                )
            ),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Missing",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );

        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(expected, result.GetProperty("outcome").GetString());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("target").ValueKind);
        Assert.Equal(JsonValueKind.Null, result.GetProperty("diagnostics").GetProperty("provider").ValueKind);
        Assert.Equal(JsonValueKind.Null, result.GetProperty("diagnostics").GetProperty("usage").ValueKind);
        Assert.Equal(JsonValueKind.Null, result.GetProperty("diagnostics").GetProperty("costEstimate").ValueKind);
        Assert.Equal(1, handler.SelectionRequestCount);
        Assert.Equal(1, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData("found", "click", "button-save", "stale_document")]
    [InlineData("not_found", "click", null, "stale_document")]
    [InlineData("unsupported", "unsupported", null, "stale_document")]
    [InlineData("found", "click", "button-save", "validation_budget_exceeded")]
    [InlineData("found", "click", "button-save", "inactive_page")]
    [InlineData("found", "click", "button-save", "stale_xpath_evidence")]
    public async Task BrowserValidationFailuresPreserveSafeCodesForSemanticOutcomes(
        string outcome,
        string action,
        string? candidateId,
        string code
    )
    {
        var handler = new DeterministicServicesHandler
        {
            ProviderBody = ProviderSelection(
                JsonSerializer.Serialize(
                    new
                    {
                        complete = true,
                        actions = new[]
                        {
                            new
                            {
                                step = 1,
                                instruction = "Click Save",
                                outcome,
                                action,
                                candidateId,
                                limitation = outcome == "unsupported" ? "unsupported_action" : "none",
                            },
                        },
                    }
                )
            ),
            SelectionStatus = HttpStatusCode.Conflict,
            SelectionBody = JsonSerializer.Serialize(
                new
                {
                    code,
                    message = "Browser validation failed.",
                    traceId = "browser-trace",
                }
            ),
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
        Assert.Equal(code, result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal("generation-1", result.GetProperty("diagnostics").GetProperty("generationId").GetString());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("target").ValueKind);
    }

    [Theory]
    [InlineData("""{"actions":[{"actionId":"a1","target":null}],"inspectedActionId":null}""")]
    [InlineData(
        """{"actions":[{"actionId":"a1","target":{"candidateId":"different","tag":"button","label":"Save","xpaths":["//*[@id='different']"]}}],"inspectedActionId":"a1"}"""
    )]
    public async Task AContradictoryBrowserSelectionCannotBecomeFound(string body)
    {
        await using var application = CreateApplication(new DeterministicServicesHandler { SelectionBody = body });
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
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal("invalid_browser_selection", result.GetProperty("diagnostics").GetProperty("code").GetString());
    }
}
