using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using static Xpathed.Resolver.Tests.DeterministicServicesHandler;
using static Xpathed.Resolver.Tests.ResolverTestApplication;

namespace Xpathed.Resolver.Tests;

public sealed class ResolutionOutcomesTests
{
    [Theory]
    [InlineData("appearance_unavailable", "unsupported")]
    [InlineData("appearance_unavailable", "click")]
    [InlineData("state_unavailable", "unsupported")]
    [InlineData("state_unavailable", "click")]
    [InlineData("target_not_addressable", "unsupported")]
    [InlineData("target_not_addressable", "click")]
    public async Task EvidenceLimitationIsPresentInProviderSchemaAndPublicResult(string limitation, string modelAction)
    {
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = ProviderSelection(
                $$"""{"complete":true,"actions":[{"step":1,"instruction":"Click the requested target","action":"{{modelAction}}","outcome":"unsupported","candidateId":null,"limitation":"{{limitation}}"}]}"""
            ),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click the red image",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("unsupported", result.GetProperty("outcome").GetString());
        Assert.Equal("unsupported", result.GetProperty("action").GetString());
        Assert.Equal("unsupported", result.GetProperty("actions")[0].GetProperty("action").GetString());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("actions")[0].GetProperty("target").ValueKind);
        Assert.Equal(1, result.GetProperty("diagnostics").GetProperty("modelCalls").GetInt32());
        Assert.Equal(limitation, result.GetProperty("actions")[0].GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(result.GetProperty("actions")[0].GetProperty("message").GetString()));
        var sent = handler.ModelRequest.GetProperty("response_format").GetProperty("json_schema").GetProperty("schema");
        Assert.Contains(
            sent.GetProperty("properties")
                .GetProperty("actions")
                .GetProperty("items")
                .GetProperty("properties")
                .GetProperty("limitation")
                .GetProperty("enum")
                .EnumerateArray(),
            item => item.GetString() == limitation
        );
    }

    [Theory]
    [InlineData("incomplete", "decomposition_incomplete")]
    [InlineData("duplicate", "provider_malformed_response")]
    [InlineData("unknown", "provider_unknown_candidate")]
    [InlineData("step_gap", "provider_malformed_response")]
    [InlineData("dependent_found", "provider_malformed_response")]
    [InlineData("empty", "provider_malformed_response")]
    [InlineData("limit", "action_budget_exceeded")]
    [InlineData("output_limit", "action_output_budget_exceeded")]
    [InlineData("truncated", "provider_truncated_response")]
    public async Task IncompleteOrInvalidActionListsCannotBecomeUsefulLookingPartialResults(string problem, string code)
    {
        var entry = new JsonObject
        {
            ["step"] = 1,
            ["instruction"] = "Click Save",
            ["outcome"] = "found",
            ["action"] = "click",
            ["candidateId"] = "button-save",
            ["limitation"] = "none",
        };
        var actions = new JsonArray(entry);
        var plan = new JsonObject { ["complete"] = true, ["actions"] = actions };
        switch (problem)
        {
            case "incomplete":
                plan["complete"] = false;
                break;
            case "duplicate":
                actions.Add(entry.DeepClone());
                break;
            case "unknown":
                entry["candidateId"] = "fabricated";
                break;
            case "step_gap":
                entry["step"] = 2;
                break;
            case "dependent_found":
                entry["limitation"] = "current_state_dependency";
                break;
            case "empty":
                actions.Clear();
                break;
            case "limit":
                for (var index = 0; index < 16; index++)
                {
                    actions.Add(entry.DeepClone());
                }

                break;
            case "output_limit":
                entry["instruction"] = new string('x', 16000);
                break;
        }
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = JsonSerializer.Serialize(
                new
                {
                    id = "generation-invalid-batch",
                    choices = new[]
                    {
                        new
                        {
                            finish_reason = problem == "truncated" ? "length" : "stop",
                            message = new { content = plan.ToJsonString() },
                        },
                    },
                    usage = new
                    {
                        prompt_tokens = 140,
                        completion_tokens = 100,
                        cost = 0.0001m,
                    },
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
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Empty(result.GetProperty("actions").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("summary").ValueKind);
        Assert.Equal(code, result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(0.0001m, result.GetProperty("diagnostics").GetProperty("usage").GetProperty("cost").GetDecimal());
        if (problem == "incomplete")
        {
            Assert.Equal(
                "The model returned an incomplete response for this instruction.",
                result.GetProperty("diagnostics").GetProperty("message").GetString()
            );
        }
        if (problem == "limit")
        {
            Assert.Equal(
                "The instruction exceeds the 16-action limit.",
                result.GetProperty("diagnostics").GetProperty("message").GetString()
            );
        }
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal(0, handler.SelectionRequestCount);
    }

    [Theory]
    [InlineData("Click Save and hover Contact", "unsupported", "unsupported_action")]
    [InlineData("Click Menu then click the revealed item", "click", "current_state_dependency")]
    [InlineData("Use that control", "unsupported", "ambiguous")]
    public async Task UnsupportedSingleInteractionCommandsRemainWholeWithoutTargets(
        string instruction,
        string action,
        string limitation
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
                                instruction,
                                action,
                                outcome = "unsupported",
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
                instruction,
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("unsupported", result.GetProperty("outcome").GetString());
        Assert.Equal(action, result.GetProperty("action").GetString());
        var item = Assert.Single(result.GetProperty("actions").EnumerateArray());
        Assert.Equal("unsupported", item.GetProperty("outcome").GetString());
        Assert.Equal(JsonValueKind.Null, item.GetProperty("target").ValueKind);
        Assert.Equal(limitation, item.GetProperty("code").GetString());
        Assert.Equal(1, result.GetProperty("summary").GetProperty("unsupported").GetInt32());
        Assert.Equal(0, result.GetProperty("summary").GetProperty("found").GetInt32());
        Assert.Equal(1, handler.ProviderRequestCount);
        var prompt = handler.ModelRequest.GetProperty("messages")[0].GetProperty("content").GetString()!;
        Assert.Contains("one interaction shared", prompt, StringComparison.Ordinal);
        Assert.DoesNotContain("ALL independently resolvable actions", prompt, StringComparison.Ordinal);
    }

    [Fact]
    public async Task PluralSingleInteractionReturnsEveryDistinctVerifiedTargetInCaptureOrder()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        var candidates = capture["candidates"]!.AsArray();
        var other = candidates[0]!.DeepClone();
        other["id"] = "button-confirm";
        other["label"] = "Confirm";
        other["text"] = "Confirm";
        candidates.Add(other);
        capture["coverage"]!["eligibleCount"] = 2;
        capture["coverage"]!["capturedCount"] = 2;
        static JsonObject ConfirmTarget()
        {
            var target = DeterministicServicesHandler.VerifiedTarget();
            target["candidateId"] = "button-confirm";
            target["label"] = "Confirm";
            target["xpaths"] = new JsonArray("//button[@id='confirm']");
            return target;
        }
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = capture.ToJsonString(),
            ProviderBody = ProviderSelection(
                """
                {"complete":true,"actions":[
                  {"step":1,"instruction":"Click Confirm","outcome":"found","action":"click","candidateId":"button-confirm","limitation":"none"},
                  {"step":1,"instruction":"Click Save","outcome":"found","action":"click","candidateId":"button-save","limitation":"none"}]}
                """
            ),
            SelectionBody = JsonSerializer.Serialize(
                new
                {
                    actions = new[]
                    {
                        new { actionId = "a1", target = DeterministicServicesHandler.VerifiedTarget() },
                        new { actionId = "a2", target = ConfirmTarget() },
                    },
                    inspectedActionId = "a1",
                }
            ),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click all buttons in Profile",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.Equal("click", result.GetProperty("action").GetString());
        var actions = result.GetProperty("actions");
        Assert.Equal(2, actions.GetArrayLength());
        Assert.Equal("button-save", actions[0].GetProperty("target").GetProperty("candidateId").GetString());
        Assert.Equal("button-confirm", actions[1].GetProperty("target").GetProperty("candidateId").GetString());
        Assert.All(actions.EnumerateArray(), item => Assert.Equal("click", item.GetProperty("action").GetString()));
        Assert.Equal(2, result.GetProperty("summary").GetProperty("found").GetInt32());
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal(1, handler.SelectionRequestCount);
    }

    [Theory]
    [InlineData("hover", "not_found", "none", null)]
    [InlineData("click", "found", "none", "button-save")]
    [InlineData("click", "unsupported", "current_state_dependency", null)]
    public async Task SingleInteractionRejectsMixedRepeatedOrSequentialTargetsBeforeBrowserVerification(
        string secondAction,
        string outcome,
        string limitation,
        string? candidateId
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
                                action = "click",
                                outcome = "found",
                                candidateId = (string?)"button-save",
                                limitation = "none",
                            },
                            new
                            {
                                step = 2,
                                instruction = "Other target",
                                action = secondAction,
                                outcome,
                                candidateId,
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
                instruction = "Click Save and Contact",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal("provider_malformed_response", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Empty(result.GetProperty("actions").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("action").ValueKind);
        Assert.Equal(JsonValueKind.Null, result.GetProperty("summary").ValueKind);
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal(0, handler.SelectionRequestCount);
    }

    [Fact]
    public async Task AProviderSelectionOutsideTheCaptureIsAnErrorWithProviderEvidence()
    {
        await using var application = CreateApplication(
            new DeterministicServicesHandler
            {
                ProviderBody =
                    """{"id":"generation-unknown","model":"deepseek/deepseek-v4.1-flash","provider":"Wafer","choices":[{"finish_reason":"stop","message":{"content":"{\"complete\":true,\"actions\":[{\"step\":1,\"instruction\":\"Click Save\",\"outcome\":\"found\",\"action\":\"click\",\"candidateId\":\"invented\",\"limitation\":\"none\"}]}"}}],"usage":{"prompt_tokens":140,"completion_tokens":15,"total_tokens":155,"cost":2.15e-05,"completion_tokens_details":{"reasoning_tokens":0}}}""",
            }
        );
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
        Assert.Equal(JsonValueKind.Null, result.GetProperty("target").ValueKind);
        var diagnostics = result.GetProperty("diagnostics");
        Assert.Equal("provider_unknown_candidate", diagnostics.GetProperty("code").GetString());
        Assert.Equal("generation-unknown", diagnostics.GetProperty("generationId").GetString());
        Assert.Equal("Wafer", diagnostics.GetProperty("provider").GetString());
        Assert.Equal(140, diagnostics.GetProperty("usage").GetProperty("inputTokens").GetInt64());
        Assert.Equal(0, diagnostics.GetProperty("usage").GetProperty("reasoningTokens").GetInt64());
        Assert.Equal(JsonValueKind.Null, diagnostics.GetProperty("usage").GetProperty("cachedTokens").ValueKind);
    }

    [Theory]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("{")]
    [InlineData("{}")]
    [InlineData("""{"outcome":"found","action":"click"}""")]
    [InlineData("""{"outcome":"found","action":"click","candidateId":null}""")]
    [InlineData("""{"outcome":"not_found","action":"click","candidateId":"button-save"}""")]
    [InlineData("""{"outcome":"other","action":"click","candidateId":null}""")]
    [InlineData("""{"outcome":"found","action":null,"candidateId":"button-save"}""")]
    [InlineData("""{"outcome":"found","action":"execute","candidateId":"button-save"}""")]
    [InlineData("""{"outcome":"unsupported","action":"click","candidateId":null}""")]
    [InlineData("""{"outcome":"found","action":"click","candidateId":"button-save","extra":true}""")]
    [InlineData("""{"outcome":"found","action":"click","candidateId":"button-save","candidateId":"button-save"}""")]
    public async Task InvalidSelectionShapesCannotBecomeSemanticResults(string selection)
    {
        await using var application = CreateApplication(
            new DeterministicServicesHandler { ProviderBody = ProviderSelection(selection) }
        );
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
        Assert.Equal("provider_malformed_response", result.GetProperty("diagnostics").GetProperty("code").GetString());
    }
}
