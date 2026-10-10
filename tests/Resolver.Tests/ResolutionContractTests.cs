using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using static Xpathed.Resolver.Tests.DeterministicServicesHandler;
using static Xpathed.Resolver.Tests.ResolverTestApplication;

namespace Xpathed.Resolver.Tests;

public sealed class ResolutionContractTests
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

    private static async Task<JsonElement> ResolveContextAsync(DeterministicServicesHandler handler, string instruction)
    {
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
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    [Theory]
    [InlineData(1, 1, 2, 2, true)]
    [InlineData(0, 1, 1, 1, true)]
    [InlineData(1, -1, 0, 1, false)]
    [InlineData(1, 1, 1, 2, false)]
    [InlineData(1, int.MaxValue, int.MinValue, int.MaxValue, false)]
    [InlineData(1, 1, 2, 1, false)]
    [InlineData(1, 0, 1, -1, false)]
    public async Task CurrentViewCoverageAccountsForExcludedCandidates(
        int captured,
        int excluded,
        int eligible,
        int scanned,
        bool valid
    )
    {
        var capture = JsonNode.Parse(CurrentViewCapture())!;
        if (captured == 0)
        {
            capture["candidates"] = new JsonArray();
        }
        capture["coverage"]!["capturedCount"] = captured;
        capture["coverage"]!["excludedOffscreenCount"] = excluded;
        capture["coverage"]!["eligibleCount"] = eligible;
        capture["coverage"]!["scannedCount"] = scanned;
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = capture.ToJsonString(),
            ProviderBody =
                captured == 0
                    ? ProviderSelection(
                        """{"complete":true,"actions":[{"step":1,"instruction":"Click Help","action":"click","outcome":"not_found","candidateId":null,"limitation":"none"}]}"""
                    )
                    : BilledSelection(),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Help",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(
            valid
                ? captured == 0
                    ? "not_found"
                    : "found"
                : "error",
            result.GetProperty("outcome").GetString()
        );
        Assert.Equal(valid ? 1 : 0, handler.ProviderRequestCount);
        if (!valid)
        {
            Assert.Equal("invalid_browser_capture", result.GetProperty("diagnostics").GetProperty("code").GetString());
        }
    }

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
    [InlineData("page")]
    [InlineData("offscreen")]
    [InlineData("appearance")]
    public async Task InvalidCurrentViewEvidenceNeverReachesTheModel(string problem)
    {
        var capture = JsonNode.Parse(CurrentViewCapture())!;
        if (problem == "page")
        {
            capture["scope"] = "page";
        }
        if (problem == "offscreen")
        {
            capture["candidates"]![0]!["state"]!["inViewport"] = false;
        }
        if (problem == "appearance")
        {
            capture["candidates"]![0]!["appearance"]!["backgroundColor"] = "url(https://private.invalid?token=secret)";
        }
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
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
        Assert.Equal("invalid_browser_capture", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(0, handler.ProviderRequestCount);
    }

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
    [InlineData("error")]
    public async Task RejectsAnOffscreenVerifiedTarget(string outcome)
    {
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = BilledSelection(),
            SelectionBody = """
                {"actions":[{"actionId":"a1","target":{"candidateId":"button-save","tag":"button","label":"Save",
                "xpaths":["//*[@data-testid='save-profile']"],"state":{"rendered":true,"inViewport":false,"enabled":true,"editable":false,"checked":null},
                "geometry":{"x":20,"y":2000,"width":90,"height":30}}}],"inspectedActionId":"a1"}
                """,
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
        Assert.Equal(outcome, result.GetProperty("outcome").GetString());
        Assert.Equal("invalid_browser_selection", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Empty(result.GetProperty("actions").EnumerateArray());
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal(1, handler.SelectionRequestCount);
        Assert.Equal(
            0.0000215m,
            result.GetProperty("diagnostics").GetProperty("usage").GetProperty("cost").GetDecimal()
        );
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
    [InlineData(false)]
    [InlineData(true)]
    public async Task ShadowContextMustMatchTheCapturedCandidate(bool mismatch)
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        var chain = JsonNode.Parse("""[{"nodeId":"main:host-1","xpath":"","label":"Preferences"}]""")!;
        capture["candidates"]![0]!["shadowChain"] = chain.DeepClone();
        var target = DeterministicServicesHandler.VerifiedTarget();
        target["shadowChain"] = chain.DeepClone();
        target["shadowChain"]![0]!["xpath"] = "//*[@data-testid='main:host-1']";
        if (mismatch)
        {
            target["shadowChain"]![0]!["xpath"] = "//another-panel";
        }

        var handler = new DeterministicServicesHandler
        {
            CaptureBody = capture.ToJsonString(),
            SelectionBody = new JsonObject
            {
                ["actions"] = new JsonArray(new JsonObject { ["actionId"] = "a1", ["target"] = target }),
                ["inspectedActionId"] = "a1",
            }.ToJsonString(),
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
        Assert.Equal(mismatch ? "error" : "found", result.GetProperty("outcome").GetString());
        if (mismatch)
        {
            Assert.Equal(
                "invalid_browser_selection",
                result.GetProperty("diagnostics").GetProperty("code").GetString()
            );
        }
        else
        {
            Assert.Equal(
                "//*[@data-testid='main:host-1']",
                result
                    .GetProperty("actions")[0]
                    .GetProperty("target")
                    .GetProperty("shadowChain")[0]
                    .GetProperty("xpath")
                    .GetString()
            );
        }

        var modelInput = handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!;
        Assert.DoesNotContain("main:host-1", modelInput, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FrameIdentityMustMatchTheCapturedCandidate(bool mismatch)
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        var frame = JsonNode.Parse(
            """{"id":"f2","documentId":"frame-document","chain":[{"frameId":"f1","nodeId":"main:outer","xpath":"","label":"Employee"},{"frameId":"f2","nodeId":"f1:inner","xpath":"","label":"Payroll"}]}"""
        )!;
        capture["candidates"]![0]!["frame"] = frame.DeepClone();
        var target = DeterministicServicesHandler.VerifiedTarget();
        target["frame"] = frame.DeepClone();
        target["frame"]!["chain"]![0]!["xpath"] = "//*[@data-testid='main:outer']";
        target["frame"]!["chain"]![1]!["xpath"] = "//*[@data-testid='f1:inner']";
        if (mismatch)
        {
            target["frame"]!["documentId"] = "another-document";
        }
        var selection = new JsonObject
        {
            ["actions"] = new JsonArray(new JsonObject { ["actionId"] = "a1", ["target"] = target }),
            ["inspectedActionId"] = "a1",
        };
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = capture.ToJsonString(),
            SelectionBody = selection.ToJsonString(),
            ProviderBody = ProviderSelection(
                """{"complete":true,"actions":[{"step":1,"instruction":"Click Save in Payroll","outcome":"found","action":"click","candidateId":"button-save","limitation":"none"}]}"""
            ),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save in Payroll",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(mismatch ? "error" : "found", result.GetProperty("outcome").GetString());
        if (mismatch)
        {
            Assert.Equal(
                "invalid_browser_selection",
                result.GetProperty("diagnostics").GetProperty("code").GetString()
            );
        }
        else
        {
            var action = result.GetProperty("actions")[0];
            Assert.Equal("f2", action.GetProperty("frameId").GetString());
            Assert.Equal(
                "frame-document",
                action.GetProperty("target").GetProperty("frame").GetProperty("documentId").GetString()
            );
            var modelInput = handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!;
            Assert.Contains("Payroll", modelInput, StringComparison.Ordinal);
            using var prepared = JsonDocument.Parse(modelInput);
            var candidate = prepared.RootElement.GetProperty("candidates")[0];
            var sentFrame = prepared.RootElement.GetProperty("context")[candidate.GetProperty("frame").GetInt32()];
            Assert.Equal("f2", sentFrame.GetProperty("id").GetString());
            Assert.Equal(2, sentFrame.GetProperty("labels").GetArrayLength());
            Assert.Equal("Employee", sentFrame.GetProperty("labels")[0].GetString());
            Assert.Equal("Payroll", sentFrame.GetProperty("labels")[1].GetString());
            Assert.DoesNotContain("frame-document", modelInput, StringComparison.Ordinal);
            Assert.DoesNotContain("//iframe", modelInput, StringComparison.Ordinal);
        }
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
    [InlineData("click", "blocked", "found")]
    [InlineData("hover", "blocked", "error")]
    [InlineData("click", "ready", "error")]
    public async Task ReadinessMustBelongToTheSelectedAction(string assessedAction, string status, string outcome)
    {
        var handler = new DeterministicServicesHandler
        {
            SelectionBody =
                """{"actions":[{"actionId":"a1","target":{"candidateId":"button-save","tag":"button","label":"Save","xpaths":["//*[@data-testid='save-profile']"],"state":{"accessibilityExposed":true,"rendered":true,"inViewport":true,"enabled":false,"editable":false,"readonly":false,"checked":null},"geometry":{"x":20,"y":40,"width":90,"height":30},"interactability":{"action":"ACTION","status":"STATUS","reasons":["disabled"],"checks":{"compatibleControl":"pass","enabled":"fail","writable":"not_applicable","viewport":"pass","pointerReception":"pass","keyboard":"not_applicable","stability":"unknown","eventOutcome":"unknown"}}}}],"inspectedActionId":"a1"}"""
                    .Replace("ACTION", assessedAction, StringComparison.Ordinal)
                    .Replace("STATUS", status, StringComparison.Ordinal),
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
        Assert.Equal(outcome, result.GetProperty("outcome").GetString());
        if (outcome == "found")
        {
            Assert.Equal(
                "blocked",
                result
                    .GetProperty("actions")[0]
                    .GetProperty("target")
                    .GetProperty("interactability")
                    .GetProperty("status")
                    .GetString()
            );
            Assert.Equal(1, result.GetProperty("diagnostics").GetProperty("modelCalls").GetInt32());
        }
        else
        {
            Assert.Equal(
                "invalid_browser_selection",
                result.GetProperty("diagnostics").GetProperty("code").GetString()
            );
        }
    }

    [Theory]
    [InlineData("ready", "pass", "found")]
    [InlineData("ready", "unknown", "error")]
    [InlineData("ready", "fail", "error")]
    [InlineData("unknown", "unknown", "found")]
    public async Task PassiveReadinessPassesIndependentlyOfUntestedEventOutcome(
        string status,
        string pointerReception,
        string outcome
    )
    {
        var handler = new DeterministicServicesHandler
        {
            SelectionBody =
                """{"actions":[{"actionId":"a1","target":{"candidateId":"button-save","tag":"button","label":"Save","xpaths":["//*[@data-testid='save-profile']"],"state":{"accessibilityExposed":true,"rendered":true,"inViewport":true,"enabled":true,"editable":false,"readonly":false,"checked":null},"geometry":{"x":20,"y":40,"width":90,"height":30},"interactability":{"action":"click","status":"STATUS","reasons":[],"checks":{"compatibleControl":"pass","enabled":"pass","writable":"not_applicable","viewport":"pass","pointerReception":"POINTER","keyboard":"not_applicable","stability":"unknown","eventOutcome":"unknown"}}}}],"inspectedActionId":"a1"}"""
                    .Replace("STATUS", status, StringComparison.Ordinal)
                    .Replace("POINTER", pointerReception, StringComparison.Ordinal),
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
        Assert.Equal(outcome, result.GetProperty("outcome").GetString());
        if (outcome == "found")
        {
            Assert.Equal(
                "unknown",
                result
                    .GetProperty("actions")[0]
                    .GetProperty("target")
                    .GetProperty("interactability")
                    .GetProperty("checks")
                    .GetProperty("eventOutcome")
                    .GetString()
            );
        }
        else
        {
            Assert.Equal(
                "invalid_browser_selection",
                result.GetProperty("diagnostics").GetProperty("code").GetString()
            );
        }
    }

    [Theory]
    [InlineData(1, "found")]
    [InlineData(2, "error")]
    public async Task ReturnsOnlyOneVerifiedXPath(int pathCount, string outcome)
    {
        string[] paths = ["//*[@data-testid='save-profile']", "//*[@id='save']"];
        var target = DeterministicServicesHandler.VerifiedTarget();
        target["xpaths"] = JsonSerializer.SerializeToNode(paths.Take(pathCount));
        var handler = new DeterministicServicesHandler
        {
            SelectionBody = JsonSerializer.Serialize(
                new { actions = new[] { new { actionId = "a1", target } }, inspectedActionId = "a1" }
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
        Assert.Equal(outcome, result.GetProperty("outcome").GetString());
        if (outcome == "error")
        {
            Assert.Equal(
                "invalid_browser_selection",
                result.GetProperty("diagnostics").GetProperty("code").GetString()
            );
        }
    }

    [Fact]
    public async Task ResolvesAnInstructionToTheVerifiedTargetOnTheManagedPage()
    {
        await using var application = CreateApplication(new DeterministicServicesHandler());
        using var client = application.CreateClient();

        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save under Profile",
                documentId = "document-1",
                imageMode = "text_only",
            }
        );

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.Equal("page-1", result.GetProperty("pageId").GetString());
        Assert.Equal("document-1", result.GetProperty("documentId").GetString());
        Assert.Equal(
            "button-save",
            result.GetProperty("actions")[0].GetProperty("target").GetProperty("candidateId").GetString()
        );
        Assert.Equal(
            "//*[@data-testid='save-profile']",
            result.GetProperty("actions")[0].GetProperty("target").GetProperty("xpaths")[0].GetString()
        );
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

    [Fact]
    public async Task IncompleteCaptureFailsBeforeModelInputAndInference()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["coverage"]!["complete"] = false;
        capture["coverage"]!["eligibleCount"] = 3;
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
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
        var diagnostics = result.GetProperty("diagnostics");
        Assert.Equal("capture_incomplete", diagnostics.GetProperty("code").GetString());
        Assert.False(diagnostics.GetProperty("capture").GetProperty("complete").GetBoolean());
        Assert.Equal(3, diagnostics.GetProperty("capture").GetProperty("eligibleCount").GetInt32());
        Assert.Equal(0, diagnostics.GetProperty("modelInputCount").GetInt32());
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DeepFrameAndShadowContextsHaveNoCaptureDepthCeiling(bool shadow)
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        var target = DeterministicServicesHandler.VerifiedTarget();
        var property = shadow ? "shadowChain" : "frame";
        var chain = new JsonArray(
            Enumerable
                .Range(1, 65)
                .Select(index =>
                    (JsonNode)(
                        shadow
                            ? new JsonObject
                            {
                                ["nodeId"] = $"host-{index}",
                                ["xpath"] = "",
                                ["label"] = $"Host {index}",
                            }
                            : new JsonObject
                            {
                                ["frameId"] = $"f{index}",
                                ["nodeId"] = $"owner-{index}",
                                ["xpath"] = "",
                                ["label"] = "Frame",
                            }
                    )
                )
                .ToArray()
        );
        JsonNode context = shadow
            ? chain
            : new JsonObject
            {
                ["id"] = "f65",
                ["documentId"] = "child",
                ["chain"] = chain,
            };
        capture["candidates"]![0]![property] = context.DeepClone();
        foreach (var step in chain)
        {
            step!["xpath"] = $"//*[@data-testid='{step["nodeId"]!.GetValue<string>()}']";
        }

        target[property] = context;
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = capture.ToJsonString(),
            SelectionBody = new JsonObject
            {
                ["actions"] = new JsonArray(new JsonObject { ["actionId"] = "a1", ["target"] = target }),
                ["inspectedActionId"] = "a1",
            }.ToJsonString(),
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
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.Equal(1, handler.ProviderRequestCount);
        var returned = result.GetProperty("actions")[0].GetProperty("target").GetProperty(property);
        Assert.Equal(65, (shadow ? returned : returned.GetProperty("chain")).GetArrayLength());
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

    [Fact]
    public async Task AResponseForAnotherDocumentFailsBeforeInference()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["documentId"] = "another-document";
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
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
        Assert.Equal("stale_document", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(0, handler.ProviderRequestCount);
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

    [Theory]
    [InlineData("missing_coverage")]
    [InlineData("missing_candidates")]
    [InlineData("duplicate_candidate")]
    [InlineData("contradictory_counts")]
    public async Task InvalidBrowserCaptureFailsBeforeInference(string problem)
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        switch (problem)
        {
            case "missing_coverage":
                capture["coverage"] = null;
                break;
            case "missing_candidates":
                capture["candidates"] = null;
                break;
            case "duplicate_candidate":
                capture["candidates"]!.AsArray().Add(capture["candidates"]![0]!.DeepClone());
                capture["coverage"]!["capturedCount"] = 2;
                capture["coverage"]!["eligibleCount"] = 2;
                break;
            case "contradictory_counts":
                capture["coverage"]!["eligibleCount"] = 2;
                break;
        }
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
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
        Assert.Equal("invalid_browser_capture", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(0, handler.ProviderRequestCount);
    }
}
