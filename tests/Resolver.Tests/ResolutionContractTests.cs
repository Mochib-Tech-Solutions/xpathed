using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Xpathed.Resolver.Controllers;

namespace Xpathed.Resolver.Tests;

public sealed class ResolutionContractTests
{
    [Theory]
    [InlineData("/pages/page-1/capture", false)]
    [InlineData("/api/v1/chat/completions", false)]
    [InlineData("/pages/page-1/selections", false)]
    [InlineData("/api/v1/chat/completions", true)]
    public async Task CurrentViewResolutionCompletesBeyondTheTwoSecondLatencyTarget(string slowPath, bool assisted)
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
        var envelope = await ResolveContextAsync(handler, assisted ? "jev-v1" : null, "Click Save", assisted);
        var result = assisted ? envelope.GetProperty("result") : envelope;
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.True(
            result.GetProperty("diagnostics").GetProperty("timingsMs").GetProperty("total").GetDouble() >= 2000
        );
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal(1, handler.SelectionRequestCount);
        Assert.Equal(assisted ? 1 : 0, handler.DecisionRequestCount);
        Assert.Equal(
            0.0000215m,
            result.GetProperty("diagnostics").GetProperty("usage").GetProperty("cost").GetDecimal()
        );
        if (assisted)
        {
            using var config = JsonDocument.Parse(
                envelope.GetProperty("evidence").GetProperty("configurationJson").GetString()!
            );
            Assert.Equal(
                JsonValueKind.Null,
                config.RootElement.GetProperty("effective").GetProperty("serverDeadlineMs").ValueKind
            );
        }
    }

    [Fact]
    public async Task EvaluationContextPlanningOmitsOnlyConfidentlyUnneededEvidence()
    {
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = BilledSelection(),
        };
        await using var application = CreateApplication(
            handler,
            new Dictionary<string, string?> { ["Evaluation:ContextPlanning"] = "jev-v1" }
        );
        using var client = application.CreateClient();
        client.DefaultRequestHeaders.Add("X-Xpathed-Attempt-Id", Guid.NewGuid().ToString("N"));
        using var response = await client.PostAsJsonAsync(
            "/internal/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                contractVersion = "4",
            }
        );
        var envelope = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", envelope.GetProperty("result").GetProperty("outcome").GetString());
        Assert.Equal(1, handler.DecisionRequestCount);
        Assert.Equal("Click Save", handler.DecisionRequest.GetProperty("state").GetString());
        using var input = JsonDocument.Parse(
            handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!
        );
        var candidate = input.RootElement.GetProperty("candidates")[0];
        Assert.Equal("button-save", candidate.GetProperty("id").GetString());
        Assert.Equal("Save", candidate.GetProperty("label").GetString());
        Assert.False(candidate.TryGetProperty("geometry", out _));
        Assert.False(candidate.TryGetProperty("appearance", out _));
        Assert.Equal(
            "not_requested",
            input.RootElement.GetProperty("evidenceAvailability").GetProperty("appearance").GetString()
        );
    }

    [Theory]
    [InlineData(0.99, 0.99, true, true, "classified")]
    [InlineData(0.99, 0.01, true, false, "classified")]
    [InlineData(0.01, 0.99, false, true, "classified")]
    [InlineData(0.05, 0.05, false, false, "classified")]
    [InlineData(0.01, 0.5, true, true, "fallback_uncertain")]
    [InlineData(0.5, 0.01, true, true, "fallback_uncertain")]
    [InlineData(-0.1, 0.01, true, true, "fallback_error")]
    [InlineData(0.01, 1.1, true, true, "fallback_error")]
    public async Task EvaluationContextPlanningPreservesCoreContextAndRecordsDecisions(
        double appearance,
        double layout,
        bool keepsAppearance,
        bool keepsGeometry,
        string status
    )
    {
        var capture = JsonNode.Parse(CurrentViewCapture())!;
        var second = capture["candidates"]![0]!.DeepClone();
        second["id"] = "second";
        second["state"]!["enabled"] = false;
        capture["candidates"]!.AsArray().Add(second);
        capture["coverage"]!["capturedCount"] = 2;
        capture["coverage"]!["eligibleCount"] = 2;
        var body = JsonSerializer.Serialize(
            new
            {
                model = "typesafe/jev-1.13-20260917",
                provider = "TypeSafe",
                answers = new
                {
                    appearance = new { type = "noul", noul = appearance },
                    layout = new { type = "noul", noul = layout },
                },
            }
        );
        var originalInstruction = "Click Save above the red link 東京";
        var control = new DeterministicServicesHandler
        {
            CaptureBody = capture.ToJsonString(),
            ProviderBody = BilledSelection(),
        };
        var assisted = new DeterministicServicesHandler
        {
            CaptureBody = capture.ToJsonString(),
            ProviderBody = BilledSelection(),
            DecisionBody = body,
        };
        var baseline = await ResolveContextAsync(control, null, originalInstruction);
        var result = await ResolveContextAsync(assisted, "jev-v1", originalInstruction);
        Assert.Equal("found", result.GetProperty("result").GetProperty("outcome").GetString());
        Assert.Equal(1, assisted.DecisionRequestCount);
        Assert.Equal(1, assisted.ProviderRequestCount);
        Assert.Equal("typesafe/jev-1.13", assisted.DecisionRequest.GetProperty("model").GetString());
        Assert.Equal(originalInstruction, assisted.DecisionRequest.GetProperty("state").GetString());
        Assert.Equal(2, assisted.DecisionRequest.GetProperty("questions").EnumerateObject().Count());
        var before = JsonNode.Parse(
            control.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!
        )!;
        var after = JsonNode.Parse(
            assisted.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!
        )!;
        Assert.Equal(originalInstruction, after["instruction"]!.GetValue<string>());
        Assert.Equal(2, after["candidates"]!.AsArray().Count);
        foreach (var candidate in after["candidates"]!.AsArray())
        {
            Assert.Equal(keepsAppearance, candidate!.AsObject().ContainsKey("appearance"));
            Assert.Equal(keepsGeometry, candidate.AsObject().ContainsKey("geometry"));
        }
        foreach (var input in new[] { before, after })
        {
            input.AsObject().Remove("evidenceAvailability");
            foreach (var candidate in input["candidates"]!.AsArray())
            {
                candidate!.AsObject().Remove("appearance");
                candidate.AsObject().Remove("geometry");
            }
        }
        Assert.Equal(before.ToJsonString(), after.ToJsonString());
        using var config = JsonDocument.Parse(
            result.GetProperty("evidence").GetProperty("configurationJson").GetString()!
        );
        Assert.Equal(status, config.RootElement.GetProperty("contextPlanning").GetProperty("status").GetString());
        Assert.Equal(
            "jev-v1",
            config
                .RootElement.GetProperty("effective")
                .GetProperty("contextPlanning")
                .GetProperty("version")
                .GetString()
        );
        Assert.NotEqual(
            baseline.GetProperty("result").GetProperty("configurationId").GetString(),
            result.GetProperty("result").GetProperty("configurationId").GetString()
        );
        Assert.Equal(
            result.GetProperty("result").GetProperty("configurationId").GetString(),
            Convert.ToHexStringLower(
                System.Security.Cryptography.SHA256.HashData(
                    System.Text.Encoding.UTF8.GetBytes(config.RootElement.GetProperty("effective").GetRawText())
                )
            )
        );
        Assert.DoesNotContain(originalInstruction, config.RootElement.GetRawText(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("{")]
    [InlineData("null")]
    [InlineData("{\"answers\":{}}")]
    [InlineData(
        "{\"answers\":{\"appearance\":{\"type\":\"noul\",\"score\":0},\"layout\":{\"type\":\"noul\",\"noul\":0}}}"
    )]
    public async Task EvaluationContextPlanningMalformedAnswersKeepFullEvidence(string body)
    {
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = BilledSelection(),
            DecisionBody = body,
        };
        var result = await ResolveContextAsync(handler, "jev-v1", "Click Save");
        Assert.Equal("found", result.GetProperty("result").GetProperty("outcome").GetString());
        using var input = JsonDocument.Parse(
            handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!
        );
        Assert.True(input.RootElement.GetProperty("candidates")[0].TryGetProperty("geometry", out _));
        Assert.True(input.RootElement.GetProperty("candidates")[0].TryGetProperty("appearance", out _));
    }

    [Theory]
    [InlineData("model")]
    [InlineData("provider")]
    [InlineData("extra_answer")]
    [InlineData("extra_root")]
    [InlineData("extra_probability")]
    public async Task EvaluationContextPlanningUntrustedAnswersNeverRemoveEvidence(string problem)
    {
        var body = JsonNode.Parse(new DeterministicServicesHandler().DecisionBody)!;
        switch (problem)
        {
            case "model":
                body["model"] = "unexpected-model";
                break;
            case "provider":
                body["provider"] = "unexpected-provider";
                break;
            case "extra_answer":
                body["answers"]!["target"] = "button-save";
                break;
            case "extra_root":
                body["prompt"] = "untrusted-provider-instruction";
                break;
            case "extra_probability":
                body["answers"]!["appearance"]!["score"] = 0;
                break;
        }
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = BilledSelection(),
            DecisionBody = body.ToJsonString(),
        };
        var result = await ResolveContextAsync(handler, "jev-v1", "Click Save");
        Assert.Equal("found", result.GetProperty("result").GetProperty("outcome").GetString());
        using var input = JsonDocument.Parse(
            handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!
        );
        Assert.True(input.RootElement.GetProperty("candidates")[0].TryGetProperty("geometry", out _));
        Assert.True(input.RootElement.GetProperty("candidates")[0].TryGetProperty("appearance", out _));
        Assert.DoesNotContain(
            "untrusted-provider-instruction",
            handler.ModelRequest.GetRawText(),
            StringComparison.Ordinal
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EvaluationContextPlanningIsDisabledForPublicRequests(bool enabled)
    {
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = BilledSelection(),
        };
        var result = await ResolveContextAsync(handler, enabled ? "jev-v1" : null, "Click Save", false);
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.Equal(0, handler.DecisionRequestCount);
        using var input = JsonDocument.Parse(
            handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!
        );
        Assert.False(input.RootElement.TryGetProperty("evidenceAvailability", out _));
        Assert.True(input.RootElement.GetProperty("candidates")[0].TryGetProperty("appearance", out _));
        Assert.DoesNotContain("jev-v1", handler.ModelRequest.GetRawText(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task EvaluationContextPlanningFailureDoesNotRetryOrChangeTheLlmModel()
    {
        var calls = 0;
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = BilledSelection(),
            BeforeRespondAsync = (path, _) =>
            {
                if (path == "/api/alpha/decisions")
                {
                    calls++;
                    throw new HttpRequestException();
                }
                return Task.CompletedTask;
            },
        };
        var result = await ResolveContextAsync(handler, "jev-v1", "Click Save");
        Assert.Equal("found", result.GetProperty("result").GetProperty("outcome").GetString());
        Assert.Equal(1, calls);
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal("deepseek/deepseek-v4.1-flash", handler.ModelRequest.GetProperty("model").GetString());
        using var input = JsonDocument.Parse(
            handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!
        );
        Assert.True(input.RootElement.GetProperty("candidates")[0].TryGetProperty("geometry", out _));
        Assert.True(input.RootElement.GetProperty("candidates")[0].TryGetProperty("appearance", out _));
    }

    [Fact]
    public async Task EvaluationContextPlanningKeepsTheSamePolicyIdentityAcrossChoices()
    {
        var first = await ResolveContextAsync(
            new DeterministicServicesHandler { CaptureBody = CurrentViewCapture(), ProviderBody = BilledSelection() },
            "jev-v1",
            "Click Save"
        );
        var second = await ResolveContextAsync(
            new DeterministicServicesHandler
            {
                CaptureBody = CurrentViewCapture(),
                ProviderBody = BilledSelection(),
                DecisionBody = new DeterministicServicesHandler()
                    .DecisionBody.Replace("0.01", "0.99", StringComparison.Ordinal)
                    .Replace("0.02", "0.99", StringComparison.Ordinal),
            },
            "jev-v1",
            "Click Save"
        );
        Assert.Equal(
            first.GetProperty("result").GetProperty("configurationId").GetString(),
            second.GetProperty("result").GetProperty("configurationId").GetString()
        );
    }

    [Fact]
    public async Task EvaluationContextPlanningDoesNotApplyToLegacyDiagnosticContracts()
    {
        var handler = new DeterministicServicesHandler { ProviderBody = BilledSelection() };
        await using var application = CreateApplication(
            handler,
            new Dictionary<string, string?> { ["Evaluation:ContextPlanning"] = "jev-v1" }
        );
        using var client = application.CreateClient();
        client.DefaultRequestHeaders.Add("X-Xpathed-Attempt-Id", Guid.NewGuid().ToString("N"));
        using var response = await client.PostAsJsonAsync(
            "/internal/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                contractVersion = "3",
            }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("result").GetProperty("outcome").GetString());
        Assert.Equal(0, handler.DecisionRequestCount);
        Assert.DoesNotContain(
            "contextPlanning",
            result.GetProperty("evidence").GetProperty("configurationJson").GetString(),
            StringComparison.Ordinal
        );
    }

    [Fact]
    public async Task EvaluationContextPlanningTimingIsSeparateFromTheFinalModelAndValidation()
    {
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = BilledSelection(),
            BeforeRespondAsync = async (path, token) =>
            {
                if (path == "/api/alpha/decisions")
                {
                    await Task.Delay(TimeSpan.FromMilliseconds(200), token);
                }
            },
        };
        var envelope = await ResolveContextAsync(handler, "jev-v1", "Click Save");
        var timings = envelope.GetProperty("result").GetProperty("diagnostics").GetProperty("timingsMs");
        using var config = JsonDocument.Parse(
            envelope.GetProperty("evidence").GetProperty("configurationJson").GetString()!
        );
        var classification = config.RootElement.GetProperty("contextPlanning").GetProperty("elapsedMs").GetDouble();
        var planning = timings.GetProperty("planning").GetDouble();
        Assert.True(planning >= classification);
        Assert.True(timings.GetProperty("model").GetDouble() < planning);
        var stages =
            timings.GetProperty("capture").GetDouble()
            + planning
            + timings.GetProperty("model").GetDouble()
            + timings.GetProperty("validation").GetDouble();
        Assert.True(stages <= timings.GetProperty("total").GetDouble());
        var baseline = await ResolveContextAsync(
            new DeterministicServicesHandler { CaptureBody = CurrentViewCapture(), ProviderBody = BilledSelection() },
            null,
            "Click Save"
        );
        Assert.False(
            baseline
                .GetProperty("result")
                .GetProperty("diagnostics")
                .GetProperty("timingsMs")
                .TryGetProperty("planning", out _)
        );
    }

    [Fact]
    public async Task EvaluationContextPlanningAfterSlowCaptureKeepsWaitingForTheFinalSelection()
    {
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = BilledSelection(),
            BeforeRespondAsync = async (path, token) =>
            {
                if (path == "/pages/page-1/capture")
                {
                    await Task.Delay(TimeSpan.FromMilliseconds(1700), token);
                }
                if (path == "/api/alpha/decisions")
                {
                    await Task.Delay(TimeSpan.FromSeconds(10), token);
                }
            },
        };
        var envelope = await ResolveContextAsync(handler, "jev-v1", "Click Save");
        var diagnostics = envelope.GetProperty("result").GetProperty("diagnostics");
        Assert.Equal("found", envelope.GetProperty("result").GetProperty("outcome").GetString());
        Assert.Equal("complete", diagnostics.GetProperty("stage").GetString());
        Assert.Equal(1, handler.ProviderRequestCount);
        var timings = diagnostics.GetProperty("timingsMs");
        Assert.True(timings.GetProperty("planning").GetDouble() > 0);
        Assert.True(timings.TryGetProperty("model", out _));
        var stages = timings.GetProperty("capture").GetDouble() + timings.GetProperty("planning").GetDouble();
        Assert.True(stages <= timings.GetProperty("total").GetDouble());
    }

    [Fact]
    public async Task EvaluationContextPlanningTimeoutFallsBackWhileResolutionKeepsWaiting()
    {
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = BilledSelection(),
            BeforeRespondAsync = async (path, token) =>
            {
                if (path == "/api/alpha/decisions")
                {
                    await Task.Delay(TimeSpan.FromSeconds(10), token);
                }
                if (path == "/pages/page-1/selections")
                {
                    await Task.Delay(TimeSpan.FromSeconds(2), token);
                }
            },
        };
        var result = await ResolveContextAsync(handler, "jev-v1", "Click Save");
        Assert.Equal("found", result.GetProperty("result").GetProperty("outcome").GetString());
        Assert.True(
            result
                .GetProperty("result")
                .GetProperty("diagnostics")
                .GetProperty("timingsMs")
                .GetProperty("total")
                .GetDouble() >= 2000
        );
        using var config = JsonDocument.Parse(
            result.GetProperty("evidence").GetProperty("configurationJson").GetString()!
        );
        Assert.Equal(
            "fallback_timeout",
            config.RootElement.GetProperty("contextPlanning").GetProperty("status").GetString()
        );
        Assert.Equal(1, handler.ProviderRequestCount);
    }

    [Fact]
    public async Task EvaluationContextPlanningRejectsUnknownStartupMode()
    {
        await using var application = CreateApplication(
            new DeterministicServicesHandler(),
            new Dictionary<string, string?> { ["Evaluation:ContextPlanning"] = "unknown" }
        );
        Assert.Throws<InvalidOperationException>(() => application.CreateClient());
    }

    private static async Task<JsonElement> ResolveContextAsync(
        DeterministicServicesHandler handler,
        string? mode,
        string instruction,
        bool diagnostic = true
    )
    {
        await using var application = CreateApplication(
            handler,
            new Dictionary<string, string?> { ["Evaluation:ContextPlanning"] = mode }
        );
        using var client = application.CreateClient();
        client.DefaultRequestHeaders.Add("X-Xpathed-Attempt-Id", Guid.NewGuid().ToString("N"));
        using var response = await client.PostAsJsonAsync(
            (diagnostic ? "/internal" : "") + "/pages/page-1/resolve",
            new
            {
                instruction,
                documentId = "document-1",
                contractVersion = "4",
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
                contractVersion = "4",
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
    [InlineData("deepseek/deepseek-v4.1-flash", "Wafer")]
    [InlineData("openai/gpt-6-luna", "Azure")]
    [InlineData("google/gemini-3.8-flash", "Google")]
    [InlineData("anthropic/claude-sonnet-4.6", "Anthropic")]
    [InlineData("example/new-model:free", "New Provider")]
    public async Task CurrentViewReturnsAndCachesPricingForTheReportedModel(string model, string provider)
    {
        var pricingCalls = 0;
        var free = model.EndsWith(":free", StringComparison.Ordinal);
        var body = JsonNode.Parse(BilledSelection())!;
        body["model"] = model;
        body["provider"] = provider;
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = body.ToJsonString(),
            PricingBody = JsonSerializer.Serialize(
                new
                {
                    data = new
                    {
                        endpoints = new[]
                        {
                            new
                            {
                                provider_name = provider,
                                pricing = new
                                {
                                    prompt = free ? "0" : "0.00000005",
                                    completion = free ? "0" : "0.0000006",
                                },
                            },
                        },
                    },
                }
            ),
            BeforeRespondAsync = (path, _) =>
            {
                if (path.EndsWith("/endpoints", StringComparison.Ordinal))
                {
                    Assert.Equal($"/api/v1/models/{model}/endpoints", Uri.UnescapeDataString(path));
                    Interlocked.Increment(ref pricingCalls);
                }
                return Task.CompletedTask;
            },
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        DateTimeOffset? fetchedAt = null;
        for (var attempt = 0; attempt < 2; attempt++)
        {
            body["usage"]!["prompt_tokens"] = 140 * (attempt + 1);
            body["usage"]!["total_tokens"] = 140 * (attempt + 1) + 15;
            handler.ProviderBody = body.ToJsonString();
            using var response = await client.PostAsJsonAsync(
                "/pages/page-1/resolve",
                new
                {
                    instruction = "Click Save",
                    documentId = "document-1",
                    contractVersion = "4",
                }
            );
            var result = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("found", result.GetProperty("outcome").GetString());
            var diagnostics = result.GetProperty("diagnostics");
            var estimate = diagnostics.GetProperty("costEstimate");
            Assert.Equal(JsonValueKind.Object, estimate.ValueKind);
            Assert.Equal(free ? 0m : 0.05m, estimate.GetProperty("inputPricePerMillion").GetDecimal());
            Assert.Equal(free ? 0m : 0.6m, estimate.GetProperty("outputPricePerMillion").GetDecimal());
            Assert.Equal(free ? 0m : 0.000007m * (attempt + 1), estimate.GetProperty("inputCost").GetDecimal());
            Assert.Equal(free ? 0m : 0.000009m, estimate.GetProperty("outputCost").GetDecimal());
            Assert.Equal(0m, estimate.GetProperty("requestCost").GetDecimal());
            Assert.Equal(
                free ? 0m
                    : attempt == 0 ? 0.000016m
                    : 0.000023m,
                estimate.GetProperty("totalCost").GetDecimal()
            );
            Assert.Equal(0.0000215m, diagnostics.GetProperty("usage").GetProperty("cost").GetDecimal());
            fetchedAt ??= estimate.GetProperty("pricingFetchedAt").GetDateTimeOffset();
            Assert.Equal(fetchedAt.Value, estimate.GetProperty("pricingFetchedAt").GetDateTimeOffset());
        }
        Assert.Equal(1, pricingCalls);
        Assert.Equal(2, handler.ProviderRequestCount);
    }

    [Fact]
    public async Task PricingCacheSeparatesModelsAndProviders()
    {
        var pricingCalls = 0;
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            BeforeRespondAsync = (path, _) =>
            {
                if (path.EndsWith("/endpoints", StringComparison.Ordinal))
                {
                    pricingCalls++;
                }
                return Task.CompletedTask;
            },
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        var completion = JsonNode.Parse(BilledSelection())!;
        var pricing = JsonNode.Parse(handler.PricingBody)!;
        foreach (
            var (model, provider, rate, expected) in new[]
            {
                ("example/first", "Provider A", "0.000001", 1m),
                ("example/second", "Provider A", "0.000002", 2m),
                ("example/second", "Provider B", "0.000003", 3m),
            }
        )
        {
            completion["model"] = model;
            completion["provider"] = provider;
            handler.ProviderBody = completion.ToJsonString();
            pricing["data"]!["endpoints"]![0]!["provider_name"] = provider;
            pricing["data"]!["endpoints"]![0]!["pricing"]!["prompt"] = rate;
            handler.PricingBody = pricing.ToJsonString();
            using var response = await client.PostAsJsonAsync(
                "/pages/page-1/resolve",
                new
                {
                    instruction = "Click Save",
                    documentId = "document-1",
                    contractVersion = "4",
                }
            );
            var result = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("found", result.GetProperty("outcome").GetString());
            Assert.Equal(
                expected,
                result
                    .GetProperty("diagnostics")
                    .GetProperty("costEstimate")
                    .GetProperty("inputPricePerMillion")
                    .GetDecimal()
            );
        }
        Assert.Equal(3, pricingCalls);
    }

    [Theory]
    [InlineData("3", false)]
    [InlineData("4", true)]
    public async Task AppearanceLimitationIsVersionedInSentAndRetainedSchema(string version, bool supported)
    {
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = supported ? CurrentViewCapture() : new DeterministicServicesHandler().CaptureBody,
            ProviderBody = ProviderSelection(
                """{"complete":true,"actions":[{"step":1,"instruction":"Click the red image","action":"unsupported","outcome":"unsupported","candidateId":null,"limitation":"appearance_unavailable"}]}"""
            ),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        client.DefaultRequestHeaders.Add("X-Xpathed-Attempt-Id", Guid.NewGuid().ToString("N"));
        using var response = await client.PostAsJsonAsync(
            "/internal/pages/page-1/resolve",
            new
            {
                instruction = "Click the red image",
                documentId = "document-1",
                contractVersion = version,
            }
        );
        var envelope = await response.Content.ReadFromJsonAsync<JsonElement>();
        var result = envelope.GetProperty("result");
        Assert.Equal(supported ? "unsupported" : "error", result.GetProperty("outcome").GetString());
        if (supported)
        {
            Assert.Equal("appearance_unavailable", result.GetProperty("actions")[0].GetProperty("code").GetString());
            Assert.Equal(
                "The requested appearance cannot be established from the captured CSS evidence.",
                result.GetProperty("actions")[0].GetProperty("message").GetString()
            );
        }
        else
        {
            Assert.Equal(
                "provider_malformed_response",
                result.GetProperty("diagnostics").GetProperty("code").GetString()
            );
        }
        var sent = handler.ModelRequest.GetProperty("response_format").GetProperty("json_schema").GetProperty("schema");
        using var retained = JsonDocument.Parse(
            envelope.GetProperty("evidence").GetProperty("outputSchema").GetString()!
        );
        Assert.True(JsonElement.DeepEquals(sent, retained.RootElement));
        using var configuration = JsonDocument.Parse(
            envelope.GetProperty("evidence").GetProperty("configurationJson").GetString()!
        );
        Assert.True(
            JsonElement.DeepEquals(
                sent,
                configuration
                    .RootElement.GetProperty("effective")
                    .GetProperty("request")
                    .GetProperty("response_format")
                    .GetProperty("json_schema")
                    .GetProperty("schema")
            )
        );
        Assert.Equal(
            supported,
            sent.GetProperty("properties")
                .GetProperty("actions")
                .GetProperty("items")
                .GetProperty("properties")
                .GetProperty("limitation")
                .GetProperty("enum")
                .EnumerateArray()
                .Any(item => item.GetString() == "appearance_unavailable")
        );
    }

    [Theory]
    [InlineData("1")]
    [InlineData("2")]
    [InlineData("3")]
    public async Task LegacyPreparedInputPreservesBaselineBytes(string version)
    {
        var handler = new DeterministicServicesHandler { ProviderBody = version == "1" ? null : BilledSelection() };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                contractVersion = version,
            }
        );
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(
            """{"instruction":"Click Save","frameId":"main","candidates":[{"id":"button-save","tag":"button","role":"button","label":"Save","scope":["Profile"],"state":{"rendered":true,"inViewport":true,"enabled":true,"editable":false},"geometry":{"x":20,"y":40,"width":90,"height":30}}]}""",
            handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CurrentViewCompactStatePreservesMeaningfulFlags(bool constrained)
    {
        var capture = JsonNode.Parse(CurrentViewCapture())!;
        var state = capture["candidates"]![0]!["state"]!;
        state["rendered"] = !constrained;
        state["enabled"] = !constrained;
        state["editable"] = constrained;
        state["readonly"] = constrained;
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = capture.ToJsonString(),
            ProviderBody = BilledSelection(),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                contractVersion = "4",
            }
        );
        using var input = JsonDocument.Parse(
            handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!
        );
        var candidate = input.RootElement.GetProperty("candidates")[0];
        var actual = candidate.GetProperty("state");
        Assert.False(actual.TryGetProperty("inViewport", out _));
        if (constrained)
        {
            Assert.False(actual.GetProperty("rendered").GetBoolean());
            Assert.False(actual.GetProperty("enabled").GetBoolean());
            Assert.True(actual.GetProperty("editable").GetBoolean());
            Assert.True(actual.GetProperty("readonly").GetBoolean());
        }
        else
        {
            Assert.Empty(actual.EnumerateObject());
        }
        Assert.False(candidate.GetProperty("appearance").TryGetProperty("limitations", out _));
        Assert.Equal("rgb(255, 0, 0)", candidate.GetProperty("appearance").GetProperty("backgroundColor").GetString());
        Assert.Equal(20, candidate.GetProperty("geometry").GetProperty("x").GetInt32());
    }

    [Theory]
    [InlineData("1", "page")]
    [InlineData("2", "page")]
    [InlineData("3", "page")]
    [InlineData("4", "current_view")]
    public async Task RequestedVersionPreservesScopeAndOnlyCurrentViewCarriesAppearance(string version, string scope)
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["scope"] = scope;
        capture["candidates"]![0]!["appearance"] = JsonNode.Parse(
            """{"backgroundColor":"rgb(255, 0, 0)","textColor":"rgb(255, 255, 255)","borderColor":null,"limitations":["background_transparent"]}"""
        );
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = capture.ToJsonString(),
            ProviderBody =
                version == "1"
                    ? null
                    : ProviderSelection(
                        """{"complete":true,"actions":[{"step":1,"instruction":"Click Save","action":"click","outcome":"found","candidateId":"button-save","limitation":"none"}]}"""
                    ),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        const string instruction = "Click the red Save control at the left of Profile";
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction,
                documentId = "document-1",
                contractVersion = version,
            }
        );
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.Equal(scope, handler.CaptureRequest.GetProperty("scope").GetString());
        using var input = JsonDocument.Parse(
            handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!
        );
        Assert.Equal(instruction, input.RootElement.GetProperty("instruction").GetString());
        var candidate = input.RootElement.GetProperty("candidates")[0];
        Assert.Equal("button-save", candidate.GetProperty("id").GetString());
        Assert.Equal("Profile", candidate.GetProperty("scope")[0].GetString());
        Assert.Equal(20, candidate.GetProperty("geometry").GetProperty("x").GetInt32());
        if (version == "4")
        {
            Assert.Equal("8", result.GetProperty("diagnostics").GetProperty("promptVersion").GetString());
            Assert.Equal("current_view", input.RootElement.GetProperty("scope").GetString());
            Assert.Equal(
                "rgb(255, 0, 0)",
                candidate.GetProperty("appearance").GetProperty("backgroundColor").GetString()
            );
            Assert.Equal(
                "background_transparent",
                candidate.GetProperty("appearance").GetProperty("limitations")[0].GetString()
            );
        }
        else
        {
            Assert.False(candidate.TryGetProperty("appearance", out _));
        }
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal(1, handler.SelectionRequestCount);
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
                contractVersion = "4",
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
    [InlineData(false)]
    [InlineData(true)]
    public async Task DisconnectedProviderChargesAreLoggedOnceWithoutLateSelection(bool duringValidation)
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var logs = new AccountingLogProvider();
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = BilledSelection(),
            BeforeRespondAsync = async (path, token) =>
            {
                if (path.EndsWith(duringValidation ? "/selections" : "/chat/completions", StringComparison.Ordinal))
                {
                    started.TrySetResult();
                    await release.Task.WaitAsync(token);
                }
            },
        };
        await using var application = CreateApplication(handler, logs: logs);
        using var client = application.CreateClient();
        using var cancellation = new CancellationTokenSource();
        var request = client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                contractVersion = "4",
            },
            cancellation.Token
        );
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await request);
        Assert.Equal(0, handler.SelectionRequestCount);
        release.SetResult();
        await logs.Recorded.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var entry = Assert.Single(logs.Entries).ToDictionary(pair => pair.Key, pair => pair.Value);
        Assert.Equal(0.0000215m, entry["ReportedUsd"]);
        Assert.Equal("generation-1", entry["GenerationId"]);
        Assert.Equal("completed", entry["AccountingStatus"]);
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal(0, handler.SelectionRequestCount);
    }

    [Theory]
    [InlineData("/pages/page-1/selections")]
    public async Task CurrentViewTransportTimeoutRetainsChargesAlreadyReported(string slowPath)
    {
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = CurrentViewCapture(),
            ProviderBody = BilledSelection(),
            BeforeRespondAsync = (path, _) =>
            {
                if (path == slowPath)
                {
                    throw new TaskCanceledException("Controlled browser transport timeout");
                }
                return Task.CompletedTask;
            },
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click Save",
                documentId = "document-1",
                contractVersion = "4",
            }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("browser_timeout", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(
            0.0000215m,
            result.GetProperty("diagnostics").GetProperty("usage").GetProperty("cost").GetDecimal()
        );
        Assert.Equal("completed", result.GetProperty("diagnostics").GetProperty("providerAccounting").GetString());
        Assert.Empty(result.GetProperty("actions").EnumerateArray());
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
                contractVersion = "4",
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
        "This step depends on a future page state. No earlier action was executed."
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
                contractVersion = "4",
            }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(outcome, result.GetProperty("outcome").GetString());
        Assert.Equal(message, result.GetProperty("actions")[0].GetProperty("message").GetString());
        Assert.Equal(1, handler.ProviderRequestCount);
        Assert.Equal(1, handler.SelectionRequestCount);
    }

    private static string CurrentViewCapture()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["scope"] = "current_view";
        capture["candidates"]![0]!["appearance"] = JsonNode.Parse(
            """{"backgroundColor":"rgb(255, 0, 0)","textColor":"rgb(0, 0, 0)","borderColor":null,"limitations":[]}"""
        );
        return capture.ToJsonString();
    }

    private static string BilledSelection()
    {
        var response = JsonNode.Parse(
            """{"id":"generation-1","model":"deepseek/deepseek-v4.1-flash","provider":"Wafer","choices":[{"finish_reason":"stop","message":{}}],"usage":{"prompt_tokens":140,"completion_tokens":15,"total_tokens":155,"cost":0.0000215}}"""
        );
        response!["choices"]![0]!["message"]!["content"] =
            """{"complete":true,"actions":[{"step":1,"instruction":"Click Save","action":"click","outcome":"found","candidateId":"button-save","limitation":"none"}]}""";
        return response.ToJsonString();
    }

    [Theory]
    [InlineData("none")]
    [InlineData("low")]
    public async Task ExplicitReasoningSettingsAreSentAndRetained(string effort)
    {
        var handler = new DeterministicServicesHandler();
        await using var application = CreateApplication(
            handler,
            new Dictionary<string, string?>
            {
                ["OpenRouter:ReasoningEffort"] = effort,
                ["OpenRouter:PromptCacheMode"] = "explicit",
            }
        );
        using var client = application.CreateClient();
        client.DefaultRequestHeaders.Add("X-Xpathed-Attempt-Id", Guid.NewGuid().ToString("N"));
        using var response = await client.PostAsJsonAsync(
            "/internal/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var envelope = await response.Content.ReadFromJsonAsync<JsonElement>();
        using var retained = JsonDocument.Parse(
            envelope.GetProperty("evidence").GetProperty("configurationJson").GetString()!
        );
        var request = retained.RootElement.GetProperty("effective").GetProperty("request");
        Assert.Equal(effort, request.GetProperty("reasoning").GetProperty("effort").GetString());
        Assert.Equal("explicit", request.GetProperty("prompt_cache_options").GetProperty("mode").GetString());
        Assert.Equal(effort, handler.ModelRequest.GetProperty("reasoning").GetProperty("effort").GetString());
    }

    [Theory]
    [InlineData("1", 512, 1, "5", null)]
    [InlineData("2", 4096, 16, "6", null)]
    [InlineData("3", 4096, 16, "7", null)]
    [InlineData("3", 4096, 16, "7-concise-1", "concise")]
    public async Task DiagnosticConfigurationDescribesEffectiveSettingsWithoutCredentialsOrPageInput(
        string version,
        int outputTokens,
        int maximumActions,
        string promptVersion,
        string? variant
    )
    {
        var handler = new DeterministicServicesHandler
        {
            ProviderBody =
                version != "1"
                    ? ProviderSelection(
                        """{"complete":true,"actions":[{"step":1,"instruction":"Click Save","action":"click","outcome":"found","candidateId":"button-save","limitation":"none"}]}"""
                    )
                    : null,
        };
        await using var application = CreateApplication(
            handler,
            new Dictionary<string, string?>
            {
                ["OpenRouter:BaseUrl"] = "http://configured-provider.test/api/v1",
                ["OpenRouter:Model"] = "configured/model",
                ["OpenRouter:Provider"] = "configured-route",
                ["OpenRouter:TimeoutSeconds"] = "47",
                ["OpenRouter:ApiKey"] = "configuration-secret-canary",
                ["Resolution:PromptVariant"] = variant,
            }
        );
        using var client = application.CreateClient();
        client.DefaultRequestHeaders.Add("X-Xpathed-Attempt-Id", Guid.NewGuid().ToString("N"));
        using var response = await client.PostAsJsonAsync(
            "/internal/pages/page-1/resolve",
            new
            {
                instruction = "Click the unique instruction-canary",
                documentId = "document-1",
                contractVersion = version,
            }
        );
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var envelope = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", envelope.GetProperty("result").GetProperty("outcome").GetString());
        using var configuration = JsonDocument.Parse(
            envelope.GetProperty("evidence").GetProperty("configurationJson").GetString()!
        );
        var effective = configuration.RootElement.GetProperty("effective");
        Assert.Equal("http://configured-provider.test/api/v1/", effective.GetProperty("endpoint").GetString());
        Assert.Equal("47", effective.GetProperty("timeoutSeconds").GetString());
        Assert.Equal(maximumActions, effective.GetProperty("maximumActions").GetInt32());
        Assert.Equal(promptVersion, effective.GetProperty("promptVersion").GetString());
        Assert.Equal(
            handler.ModelRequest.GetProperty("messages")[0].GetProperty("content").GetString(),
            envelope.GetProperty("evidence").GetProperty("systemPrompt").GetString()
        );
        Assert.False(effective.GetProperty("responseCache").GetBoolean());
        var request = effective.GetProperty("request");
        Assert.Equal("configured/model", request.GetProperty("model").GetString());
        Assert.Equal("configured-route", request.GetProperty("provider").GetProperty("only")[0].GetString());
        Assert.Equal(outputTokens, request.GetProperty("max_tokens").GetInt32());
        Assert.False(request.GetProperty("reasoning").GetProperty("enabled").GetBoolean());
        Assert.Equal(string.Empty, request.GetProperty("messages")[1].GetProperty("content").GetString());
        Assert.Equal(
            envelope.GetProperty("evidence").GetProperty("systemPrompt").GetString(),
            request.GetProperty("messages")[0].GetProperty("content").GetString()
        );
        Assert.DoesNotContain(
            "configuration-secret-canary",
            configuration.RootElement.GetRawText(),
            StringComparison.Ordinal
        );
        Assert.DoesNotContain("instruction-canary", configuration.RootElement.GetRawText(), StringComparison.Ordinal);
        Assert.DoesNotContain("button-save", configuration.RootElement.GetRawText(), StringComparison.Ordinal);
        Assert.Equal(
            envelope.GetProperty("result").GetProperty("configurationId").GetString(),
            Convert.ToHexStringLower(
                System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(effective.GetRawText()))
            )
        );
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
            new { instruction = failure == 2 ? "" : "Click Save", documentId = "document-1" }
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

    [Theory]
    [InlineData("API_KEY=violet-cactus-782")]
    [InlineData("Bearer violet-cactus-782")]
    [InlineData("https://alice:violet-cactus-782@example.org/settings?auth=violet-cactus-782#violet-cactus-782")]
    public async Task InternalEvidenceSanitizesCredentialBearingPageLabels(string label)
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["candidates"]![0]!["label"] = label;
        await using var application = CreateApplication(
            new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() }
        );
        using var client = application.CreateClient();
        client.DefaultRequestHeaders.Add("X-Xpathed-Attempt-Id", Guid.NewGuid().ToString("N"));
        using var response = await client.PostAsJsonAsync(
            "/internal/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        var envelope = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.DoesNotContain(
            "violet-cactus-782",
            envelope.GetProperty("evidence").GetRawText(),
            StringComparison.Ordinal
        );
        Assert.Contains(
            "button-save",
            envelope.GetProperty("evidence").GetProperty("modelInput").GetString(),
            StringComparison.Ordinal
        );
    }

    [Theory]
    [InlineData(null)]
    [InlineData("invalid")]
    [InlineData("0123456789abcdef0123456789abcdef,0123456789abcdef0123456789abcdef")]
    public async Task InternalResolutionRejectsInvalidAttemptIdentity(string? attempt)
    {
        var handler = new DeterministicServicesHandler();
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        if (attempt is not null)
        {
            client.DefaultRequestHeaders.Add("X-Xpathed-Attempt-Id", attempt);
        }
        using var response = await client.PostAsJsonAsync(
            "/internal/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    [Fact]
    public async Task EvidenceMarksMissingInputWhenConfigurationFailsBeforeCapture()
    {
        await using var application = CreateApplication(
            new DeterministicServicesHandler(),
            new Dictionary<string, string?> { ["OpenRouter:ApiKey"] = null }
        );
        using var client = application.CreateClient();
        client.DefaultRequestHeaders.Add("X-Xpathed-Attempt-Id", Guid.NewGuid().ToString("N"));
        using var response = await client.PostAsJsonAsync(
            "/internal/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        var envelope = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", envelope.GetProperty("result").GetProperty("outcome").GetString());
        Assert.Equal(
            "provider_not_configured",
            envelope.GetProperty("result").GetProperty("diagnostics").GetProperty("code").GetString()
        );
        Assert.Equal(
            "model_input_unavailable",
            envelope.GetProperty("evidence").GetProperty("availability").GetString()
        );
        Assert.Equal(JsonValueKind.Null, envelope.GetProperty("evidence").GetProperty("modelInput").ValueKind);
    }

    [Fact]
    public async Task PublicResolutionDoesNotExposeEvidenceAndInternalRouteRejectsBrowserOrigins()
    {
        await using var application = CreateApplication(new DeterministicServicesHandler());
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.False(result.TryGetProperty("evidence", out _));
        client.DefaultRequestHeaders.Add("Origin", "http://localhost:8080");
        client.DefaultRequestHeaders.Add("X-Xpathed-Attempt-Id", Guid.NewGuid().ToString("N"));
        using var blocked = await client.PostAsJsonAsync(
            "/internal/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        Assert.Equal(HttpStatusCode.Forbidden, blocked.StatusCode);
    }

    [Fact]
    public async Task InterpretedDataEntryAlsoWithholdsEvidenceForUnrecognizedWording()
    {
        var handler = new DeterministicServicesHandler
        {
            ProviderBody = ProviderSelection("""{"outcome":"not_found","action":"fill","candidateId":null}"""),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        client.DefaultRequestHeaders.Add("X-Xpathed-Attempt-Id", Guid.NewGuid().ToString("N"));
        using var response = await client.PostAsJsonAsync(
            "/internal/pages/page-1/resolve",
            new { instruction = "Put violet-cactus-782 there", documentId = "document-1" }
        );
        var envelope = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("fill", envelope.GetProperty("result").GetProperty("action").GetString());
        Assert.Equal(
            "withheld_sensitive_instruction",
            envelope.GetProperty("evidence").GetProperty("availability").GetString()
        );
        Assert.DoesNotContain(
            "violet-cactus-782",
            envelope.GetProperty("evidence").GetRawText(),
            StringComparison.Ordinal
        );
    }

    [Theory]
    [InlineData("Set input to violet-cactus-782")]
    [InlineData("Paste violet-cactus-782 into the field")]
    [InlineData("Fill email with violet-cactus-782")]
    [InlineData("Type violet-cactus-782")]
    [InlineData("Upload violet-cactus-782")]
    public async Task InternalEvidenceWithholdsEnteredValues(string instruction)
    {
        await using var application = CreateApplication(new DeterministicServicesHandler());
        using var client = application.CreateClient();
        client.DefaultRequestHeaders.Add("X-Xpathed-Attempt-Id", Guid.NewGuid().ToString("N"));
        using var response = await client.PostAsJsonAsync(
            "/internal/pages/page-1/resolve",
            new { instruction, documentId = "document-1" }
        );
        var envelope = await response.Content.ReadFromJsonAsync<JsonElement>();
        var evidence = envelope.GetProperty("evidence");
        Assert.Equal("withheld_sensitive_instruction", evidence.GetProperty("availability").GetString());
        Assert.Equal("[redacted]", evidence.GetProperty("instruction").GetString());
        Assert.Equal(JsonValueKind.Null, evidence.GetProperty("modelInput").ValueKind);
        Assert.DoesNotContain("violet-cactus-782", evidence.GetRawText(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task InternalResolutionReturnsBoundedEvidenceAndCallerAttemptIdentity()
    {
        var handler = new DeterministicServicesHandler();
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        client.DefaultRequestHeaders.Add("X-Xpathed-Attempt-Id", "0123456789abcdef0123456789abcdef");
        using var response = await client.PostAsJsonAsync(
            "/internal/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var envelope = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", envelope.GetProperty("result").GetProperty("outcome").GetString());
        Assert.Equal(
            "0123456789abcdef0123456789abcdef",
            envelope.GetProperty("result").GetProperty("attemptId").GetString()
        );
        var evidence = envelope.GetProperty("evidence");
        Assert.Equal("sanitized", evidence.GetProperty("availability").GetString());
        Assert.Contains("button-save", evidence.GetProperty("modelInput").GetString(), StringComparison.Ordinal);
        Assert.DoesNotContain("test-token", envelope.GetRawText(), StringComparison.Ordinal);
        Assert.Equal(1, handler.ProviderRequestCount);
    }

    [Fact]
    public async Task CompactModelInputPreservesCandidatesAndMeaningWithoutDuplicateOrPrivateState()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        var candidates = capture["candidates"]!.AsArray();
        var second = candidates[0]!.DeepClone();
        second["id"] = "other-save";
        second["text"] = "Save changes";
        second["state"]!["enabled"] = false;
        second["state"]!["readonly"] = true;
        candidates.Add(second);
        capture["coverage"]!["eligibleCount"] = 2;
        capture["coverage"]!["capturedCount"] = 2;
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click Save in Profile", documentId = "document-1" }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        using var input = JsonDocument.Parse(
            handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!
        );
        var sent = input.RootElement.GetProperty("candidates");
        Assert.Equal(2, sent.GetArrayLength());
        Assert.Equal("button-save", sent[0].GetProperty("id").GetString());
        Assert.Equal("Save", sent[0].GetProperty("label").GetString());
        Assert.Equal("Profile", sent[0].GetProperty("scope")[0].GetString());
        Assert.Equal(20, sent[0].GetProperty("geometry").GetProperty("x").GetDouble());
        Assert.False(sent[0].TryGetProperty("text", out _));
        Assert.False(sent[0].TryGetProperty("placeholder", out _));
        Assert.False(sent[0].GetProperty("state").TryGetProperty("checked", out _));
        Assert.False(sent[0].GetProperty("state").TryGetProperty("version", out _));
        Assert.False(sent[0].GetProperty("state").GetProperty("editable").GetBoolean());
        Assert.Equal("Save changes", sent[1].GetProperty("text").GetString());
        Assert.False(sent[1].GetProperty("state").GetProperty("enabled").GetBoolean());
        Assert.True(sent[1].GetProperty("state").GetProperty("readonly").GetBoolean());
    }

    [Theory]
    [InlineData("1", false)]
    [InlineData("2", false)]
    [InlineData("1", true)]
    [InlineData("2", true)]
    public async Task FrameIdentityMustMatchTheCapturedCandidate(string version, bool mismatch)
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        var frame = JsonNode.Parse(
            """{"id":"f2","documentId":"frame-document","chain":[{"frameId":"f1","xpath":"//iframe[@id='outer']","label":"Employee"},{"frameId":"f2","xpath":"//iframe[@id='inner']","label":"Payroll"}]}"""
        )!;
        capture["candidates"]![0]!["frame"] = frame.DeepClone();
        var target = JsonNode.Parse(
            """{"candidateId":"button-save","tag":"button","label":"Save","xpaths":["//button"],"state":{"rendered":true,"inViewport":true,"enabled":true,"editable":false,"checked":null},"geometry":{"x":150,"y":150,"width":120,"height":40}}"""
        )!;
        target["frame"] = frame.DeepClone();
        if (mismatch)
        {
            target["frame"]!["documentId"] = "another-document";
        }
        var selection =
            version == "1"
                ? new JsonObject { ["target"] = target }
                : new JsonObject
                {
                    ["actions"] = new JsonArray(new JsonObject { ["actionId"] = "a1", ["target"] = target }),
                    ["inspectedActionId"] = "a1",
                };
        var handler = new DeterministicServicesHandler
        {
            CaptureBody = capture.ToJsonString(),
            SelectionBody = selection.ToJsonString(),
            ProviderBody = ProviderSelection(
                version == "1"
                    ? """{"outcome":"found","action":"click","candidateId":"button-save"}"""
                    : """{"complete":true,"actions":[{"step":1,"instruction":"Click Save in Payroll","outcome":"found","action":"click","candidateId":"button-save","limitation":"none"}]}"""
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
                contractVersion = version,
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
            var action = version == "1" ? result : result.GetProperty("actions")[0];
            Assert.Equal("f2", action.GetProperty("frameId").GetString());
            Assert.Equal(
                "frame-document",
                action.GetProperty("target").GetProperty("frame").GetProperty("documentId").GetString()
            );
            var modelInput = handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!;
            Assert.Contains("Payroll", modelInput, StringComparison.Ordinal);
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
                contractVersion = "2",
            }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal("invalid_browser_selection", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Empty(result.GetProperty("actions").EnumerateArray());
    }

    [Theory]
    [InlineData("incomplete", "decomposition_incomplete", "2")]
    [InlineData("incomplete", "decomposition_incomplete", "3")]
    [InlineData("incomplete", "decomposition_incomplete", "4")]
    [InlineData("duplicate", "provider_malformed_response", "2")]
    [InlineData("duplicate", "provider_malformed_response", "3")]
    [InlineData("unknown", "provider_unknown_candidate", "2")]
    [InlineData("unknown", "provider_unknown_candidate", "3")]
    [InlineData("step_gap", "provider_malformed_response", "2")]
    [InlineData("step_gap", "provider_malformed_response", "3")]
    [InlineData("dependent_found", "provider_malformed_response", "2")]
    [InlineData("dependent_found", "provider_malformed_response", "3")]
    [InlineData("empty", "provider_malformed_response", "2")]
    [InlineData("empty", "provider_malformed_response", "3")]
    [InlineData("limit", "action_budget_exceeded", "2")]
    [InlineData("limit", "action_budget_exceeded", "3")]
    [InlineData("limit", "action_budget_exceeded", "4")]
    [InlineData("output_limit", "action_output_budget_exceeded", "2")]
    [InlineData("output_limit", "action_output_budget_exceeded", "3")]
    [InlineData("truncated", "provider_truncated_response", "2")]
    [InlineData("truncated", "provider_truncated_response", "3")]
    public async Task IncompleteOrInvalidActionListsCannotBecomeUsefulLookingPartialResults(
        string problem,
        string code,
        string version
    )
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
            CaptureBody = version == "4" ? CurrentViewCapture() : new DeterministicServicesHandler().CaptureBody,
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
                contractVersion = version,
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
                contractVersion = "3",
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
        Assert.Equal("7", result.GetProperty("diagnostics").GetProperty("promptVersion").GetString());
        var prompt = handler.ModelRequest.GetProperty("messages")[0].GetProperty("content").GetString()!;
        Assert.Contains("ONE interaction type", prompt, StringComparison.Ordinal);
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
            SelectionBody = """
                {"actions":[
                  {"actionId":"a1","target":{"candidateId":"button-save","tag":"button","label":"Save","xpaths":["//button[@id='save']"],
                   "state":{"rendered":true,"inViewport":true,"enabled":true,"editable":false},"geometry":{"x":20,"y":40,"width":90,"height":30}}},
                  {"actionId":"a2","target":{"candidateId":"button-confirm","tag":"button","label":"Confirm","xpaths":["//button[@id='confirm']"],
                   "state":{"rendered":true,"inViewport":true,"enabled":true,"editable":false},"geometry":{"x":20,"y":80,"width":90,"height":30}}}],
                 "inspectedActionId":"a1"}
                """,
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new
            {
                instruction = "Click all buttons in Profile",
                documentId = "document-1",
                contractVersion = "3",
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
                contractVersion = "3",
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
                contractVersion = "3",
            }
        );
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("3", result.GetProperty("contractVersion").GetString());
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

    [Fact]
    public async Task CurrentPageActionsPreserveIndependentOutcomesWithOneInferenceCharge()
    {
        var handler = new DeterministicServicesHandler
        {
            ProviderBody = JsonSerializer.Serialize(
                new
                {
                    id = "generation-batch",
                    model = "deepseek/deepseek-v4.1-flash",
                    provider = "Wafer",
                    choices = new[]
                    {
                        new
                        {
                            finish_reason = "stop",
                            message = new
                            {
                                content = """
                                {"complete":true,"actions":[
                                  {"step":1,"instruction":"Click Save","outcome":"found","action":"click","candidateId":"button-save","limitation":"none"},
                                  {"step":2,"instruction":"Hover Contact","outcome":"not_found","action":"hover","candidateId":null,"limitation":"none"}]}
                                """,
                            },
                        },
                    },
                    usage = new
                    {
                        prompt_tokens = 140,
                        completion_tokens = 100,
                        total_tokens = 240,
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
                instruction = "Click Save and hover Contact",
                documentId = "document-1",
                contractVersion = "2",
            }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("2", result.GetProperty("contractVersion").GetString());
        Assert.Equal("partial", result.GetProperty("outcome").GetString());
        var actions = result.GetProperty("actions");
        Assert.Equal(2, actions.GetArrayLength());
        Assert.Equal("a1", actions[0].GetProperty("actionId").GetString());
        Assert.Equal("button-save", actions[0].GetProperty("target").GetProperty("candidateId").GetString());
        Assert.Equal("not_found", actions[1].GetProperty("outcome").GetString());
        Assert.Equal(JsonValueKind.Null, actions[1].GetProperty("target").ValueKind);
        Assert.Equal(1, result.GetProperty("summary").GetProperty("found").GetInt32());
        Assert.Equal(1, result.GetProperty("summary").GetProperty("notFound").GetInt32());
        Assert.All(
            actions.EnumerateArray(),
            action =>
                Assert.Equal(
                    result.GetProperty("attemptId").GetString(),
                    action.GetProperty("diagnosticsReference").GetString()
                )
        );
        Assert.Equal(0.0001m, result.GetProperty("diagnostics").GetProperty("usage").GetProperty("cost").GetDecimal());
        Assert.Equal(1, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData("click", "blocked", "found")]
    [InlineData("hover", "blocked", "error")]
    [InlineData("click", "ready", "error")]
    public async Task VersionedReadinessMustBelongToTheSelectedAction(
        string assessedAction,
        string status,
        string outcome
    )
    {
        var handler = new DeterministicServicesHandler
        {
            SelectionBody = """
                {"target":{"candidateId":"button-save","tag":"button","label":"Save","xpaths":["//button"],
                  "state":{"version":"2","accessibilityExposed":true,"rendered":true,"inViewport":true,"enabled":false,"editable":false,"readonly":false,"checked":null},
                  "geometry":{"x":20,"y":40,"width":90,"height":30},
                  "interactability":{"version":"1","action":"ACTION","status":"STATUS","reasons":["disabled"],
                    "checks":{"compatibleControl":"pass","enabled":"fail","writable":"not_applicable","viewport":"pass",
                      "pointerReception":"pass","keyboard":"not_applicable","stability":"unknown","eventOutcome":"unknown"}}}}
                """.Replace("ACTION", assessedAction, StringComparison.Ordinal).Replace(
                "STATUS",
                status,
                StringComparison.Ordinal
            ),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(outcome, result.GetProperty("outcome").GetString());
        if (outcome == "found")
        {
            Assert.Equal("1", result.GetProperty("contractVersion").GetString());
            Assert.Equal(
                "blocked",
                result.GetProperty("target").GetProperty("interactability").GetProperty("status").GetString()
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
    [InlineData("1", "ready", "pass", "error")]
    [InlineData("2", "ready", "pass", "found")]
    [InlineData("2", "ready", "unknown", "error")]
    [InlineData("2", "ready", "fail", "error")]
    [InlineData("2", "unknown", "unknown", "found")]
    public async Task PassiveReadinessPassesIndependentlyOfUntestedEventOutcome(
        string version,
        string status,
        string pointerReception,
        string outcome
    )
    {
        var handler = new DeterministicServicesHandler
        {
            SelectionBody = """
                {"target":{"candidateId":"button-save","tag":"button","label":"Save","xpaths":["//button"],
                  "state":{"version":"2","accessibilityExposed":true,"rendered":true,"inViewport":true,"enabled":true,"editable":false,"readonly":false,"checked":null},
                  "geometry":{"x":20,"y":40,"width":90,"height":30},
                  "interactability":{"version":"VERSION","action":"click","status":"STATUS","reasons":[],
                    "checks":{"compatibleControl":"pass","enabled":"pass","writable":"not_applicable","viewport":"pass",
                      "pointerReception":"POINTER","keyboard":"not_applicable","stability":"unknown","eventOutcome":"unknown"}}}}
                """.Replace("VERSION", version, StringComparison.Ordinal).Replace(
                "STATUS",
                status,
                StringComparison.Ordinal
            ).Replace("POINTER", pointerReception, StringComparison.Ordinal),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(outcome, result.GetProperty("outcome").GetString());
        if (outcome == "found")
        {
            Assert.Equal(
                "unknown",
                result
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
        string[] paths = ["//button", "//*[@id='save']"];
        var handler = new DeterministicServicesHandler
        {
            SelectionBody = JsonSerializer.Serialize(
                new
                {
                    target = new
                    {
                        candidateId = "button-save",
                        tag = "button",
                        label = "Save",
                        xpaths = paths.Take(pathCount),
                        state = new
                        {
                            rendered = true,
                            inViewport = true,
                            enabled = true,
                            editable = false,
                        },
                        geometry = new
                        {
                            x = 20,
                            y = 40,
                            width = 90,
                            height = 30,
                        },
                    },
                }
            ),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
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
            new { instruction = "Click Save under Profile", documentId = "document-1" }
        );

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.Equal("page-1", result.GetProperty("pageId").GetString());
        Assert.Equal("document-1", result.GetProperty("documentId").GetString());
        Assert.Equal("button-save", result.GetProperty("target").GetProperty("candidateId").GetString());
        Assert.Equal(
            "//*[@data-testid='save-profile']",
            result.GetProperty("target").GetProperty("xpaths")[0].GetString()
        );
    }

    [Fact]
    public async Task AProviderSelectionOutsideTheCaptureIsAnErrorWithProviderEvidence()
    {
        await using var application = CreateApplication(
            new DeterministicServicesHandler
            {
                ProviderBody = """
                {"id":"generation-unknown","model":"deepseek/deepseek-v4.1-flash","provider":"Wafer",
                 "choices":[{"finish_reason":"stop","message":{"content":"{\"outcome\":\"found\",\"action\":\"click\",\"candidateId\":\"invented\"}"}}],
                 "usage":{"prompt_tokens":140,"completion_tokens":15,"total_tokens":155,"cost":0.0000215,"completion_tokens_details":{"reasoning_tokens":0}}}
                """,
            }
        );
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
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
            new { instruction = "Click Save", documentId = "document-1" }
        );

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal("provider_malformed_response", result.GetProperty("diagnostics").GetProperty("code").GetString());
    }

    [Theory]
    [InlineData(401, "{}", "provider_authentication")]
    [InlineData(429, "{}", "provider_rate_limited")]
    [InlineData(408, "{}", "provider_timeout")]
    [InlineData(503, "{}", "provider_unavailable")]
    [InlineData(
        200,
        """{"error":{"code":401,"metadata":{"error_type":"authentication"}}}""",
        "provider_authentication"
    )]
    [InlineData(
        200,
        """{"choices":[{"finish_reason":"error","error":{"code":429,"metadata":{"error_type":"rate_limit_exceeded"}}}]}""",
        "provider_rate_limited"
    )]
    [InlineData(200, "{", "provider_malformed_response")]
    [InlineData(200, "{}", "provider_malformed_response")]
    [InlineData(200, """{"choices":[]}""", "provider_malformed_response")]
    [InlineData(200, """{"choices":[{"finish_reason":"stop","message":{"content":""}}]}""", "provider_empty_response")]
    [InlineData(
        200,
        """{"choices":[{"finish_reason":"length","message":{"content":""}}]}""",
        "provider_truncated_response"
    )]
    [InlineData(
        200,
        """{"choices":[{"finish_reason":"content_filter","message":{"content":null,"refusal":"Declined"}}]}""",
        "provider_refused"
    )]
    public async Task ProviderFailuresRemainDistinctFromSemanticAbsence(int status, string body, string code)
    {
        await using var application = CreateApplication(
            new DeterministicServicesHandler { ProviderStatus = (HttpStatusCode)status, ProviderBody = body }
        );
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal(code, result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("target").ValueKind);
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
            new { instruction = "Click Save", documentId = "document-1" }
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

    [Fact]
    public async Task RepresentationAboveTheOldBudgetReachesInferenceWithoutTruncation()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["candidates"]![0]!["text"] = new string('x', 100000);
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );

        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        Assert.True(result.GetProperty("diagnostics").GetProperty("modelInputBytes").GetInt32() > 100000);
        Assert.Equal(1, handler.ProviderRequestCount);
    }

    [Fact]
    public async Task OversizedRepresentationFailsWithoutTruncationOrInference()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["candidates"]![0]!["text"] = new string('x', 512000);
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );

        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        var diagnostics = result.GetProperty("diagnostics");
        Assert.Equal("model_input_budget_exceeded", diagnostics.GetProperty("code").GetString());
        Assert.True(diagnostics.GetProperty("capture").GetProperty("complete").GetBoolean());
        Assert.True(diagnostics.GetProperty("modelInputBytes").GetInt32() > 512000);
        Assert.Equal(0, diagnostics.GetProperty("modelCalls").GetInt32());
        Assert.Equal(0, handler.ProviderRequestCount);
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
                        outcome,
                        action,
                        candidateId = (string?)null,
                    }
                )
            ),
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click Missing", documentId = "document-1" }
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
                        outcome,
                        action,
                        candidateId,
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
            new { instruction = "Click Save", documentId = "document-1" }
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
            new { instruction = "Click Save", documentId = "document-1" }
        );

        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal("stale_document", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData("/api/v1/chat/completions", "provider_timeout")]
    [InlineData("/pages/page-1/capture", "browser_timeout")]
    [InlineData("/pages/page-1/selection", "browser_timeout")]
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
            new { instruction = "Click Save", documentId = "document-1" }
        );

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal(expectedCode, result.GetProperty("diagnostics").GetProperty("code").GetString());
    }

    [Theory]
    [InlineData("/api/v1/chat/completions")]
    [InlineData("/pages/page-1/capture")]
    [InlineData("/pages/page-1/selection")]
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
            new { instruction = "Click Save", documentId = "document-1" },
            cancellation.Token
        );
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await cancellation.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => response);
        await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Theory]
    [InlineData("""{"target":null}""")]
    [InlineData(
        """{"target":{"candidateId":"different","tag":"button","label":"Save","xpaths":["//*[@id='different']"]}}"""
    )]
    public async Task AContradictoryBrowserSelectionCannotBecomeFound(string body)
    {
        await using var application = CreateApplication(new DeterministicServicesHandler { SelectionBody = body });
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
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
    [InlineData("OpenRouter:ApiKey", null, "provider_not_configured")]
    [InlineData("Resolution:Strategy", "unimplemented", "unsupported_strategy")]
    [InlineData("OpenRouter:BaseUrl", "file:///tmp/model/", "invalid_provider_configuration")]
    [InlineData("OpenRouter:BaseUrl", "http://user:password@localhost/api/v1/", "invalid_provider_configuration")]
    [InlineData("OpenRouter:TimeoutSeconds", "0", "invalid_provider_configuration")]
    [InlineData("OpenRouter:TimeoutSeconds", "invalid", "invalid_provider_configuration")]
    [InlineData("OpenRouter:TimeoutSeconds", "601", "invalid_provider_configuration")]
    [InlineData("OpenRouter:TimeoutSeconds", "NaN", "invalid_provider_configuration")]
    [InlineData("OpenRouter:TimeoutSeconds", "Infinity", "invalid_provider_configuration")]
    [InlineData("OpenRouter:TimeoutSeconds", "-Infinity", "invalid_provider_configuration")]
    [InlineData("OpenRouter:ReasoningEffort", "maximum", "invalid_provider_configuration")]
    [InlineData("OpenRouter:PromptCacheMode", "automatic", "invalid_provider_configuration")]
    public async Task InvalidConfigurationCannotClaimAModelCall(string key, string? value, string expectedCode)
    {
        var handler = new DeterministicServicesHandler();
        await using var application = CreateApplication(handler, new Dictionary<string, string?> { [key] = value });
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal(expectedCode, result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(0, result.GetProperty("diagnostics").GetProperty("modelCalls").GetInt32());
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData("OpenRouter:Model", "other/model", "Click Save", false)]
    [InlineData("OpenRouter:Provider", "other", "Click Save", false)]
    [InlineData("OpenRouter:ReasoningEffort", "none", "Click Save", false)]
    [InlineData("OpenRouter:PromptCacheMode", "explicit", "Click Save", false)]
    [InlineData("OpenRouter:BaseUrl", "http://localhost:9089/api/v1/", "Click Save", false)]
    [InlineData("OpenRouter:TimeoutSeconds", "31", "Click Save", false)]
    [InlineData("OpenRouter:ApiKey", "another-test-key", "Click Save", true)]
    [InlineData("OpenRouter:ApiKey", "another-test-key", "Hover over Save", true)]
    public async Task ConfigurationIdentityDependsOnSettingsAndExcludesKeyAndInstruction(
        string key,
        string value,
        string instruction,
        bool sameConfiguration
    )
    {
        var first = await ResolveConfigurationAsync([], "Click Save");
        var changed = await ResolveConfigurationAsync(new Dictionary<string, string?> { [key] = value }, instruction);
        if (sameConfiguration)
        {
            Assert.Equal(first, changed);
        }
        else
        {
            Assert.NotEqual(first, changed);
        }

        static async Task<string?> ResolveConfigurationAsync(Dictionary<string, string?> settings, string instruction)
        {
            await using var application = CreateApplication(new DeterministicServicesHandler(), settings);
            using var client = application.CreateClient();
            using var response = await client.PostAsJsonAsync(
                "/pages/page-1/resolve",
                new { instruction, documentId = "document-1" }
            );
            var result = await response.Content.ReadFromJsonAsync<JsonElement>();
            return result.GetProperty("configurationId").GetString();
        }
    }

    [Fact]
    public async Task ProviderRequestPinsSupportedSettingsAndPreservesUnicodeLabels()
    {
        var capture = JsonNode.Parse(new DeterministicServicesHandler().CaptureBody)!;
        capture["candidates"]![0]!["label"] = "Sauvegarder 東京";
        var handler = new DeterministicServicesHandler { CaptureBody = capture.ToJsonString() };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = handler.ModelRequest;
        Assert.Equal("deepseek/deepseek-v4.1-flash", body.GetProperty("model").GetString());
        Assert.False(body.GetProperty("reasoning").GetProperty("enabled").GetBoolean());
        Assert.False(body.TryGetProperty("service_tier", out _));
        Assert.Equal(512, body.GetProperty("max_tokens").GetInt32());
        Assert.Equal("wafer", body.GetProperty("provider").GetProperty("only")[0].GetString());
        Assert.False(body.GetProperty("provider").TryGetProperty("max_price", out _));
        Assert.False(body.GetProperty("provider").GetProperty("allow_fallbacks").GetBoolean());
        Assert.True(body.GetProperty("provider").GetProperty("require_parameters").GetBoolean());
        Assert.True(body.GetProperty("response_format").GetProperty("json_schema").GetProperty("strict").GetBoolean());
        Assert.False(body.TryGetProperty("tools", out _));
        Assert.False(body.TryGetProperty("temperature", out _));
        Assert.Contains(
            "東京",
            body.GetProperty("messages")[1].GetProperty("content").GetString(),
            StringComparison.Ordinal
        );
    }

    [Fact]
    public async Task ReturnsRouteRatesAndTokenCostEstimateSeparatelyFromReportedCost()
    {
        var handler = new DeterministicServicesHandler
        {
            PricingBody = """
                {"data":{"endpoints":[
                  {"provider_name":"Other","pricing":{"prompt":"99","completion":"99"}},
                  {"provider_name":"Wafer","pricing":{"prompt":"0.0000000749","completion":"0.00000044","request":"0.000001"}}]}}
                """,
        };
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("found", result.GetProperty("outcome").GetString());
        var diagnostics = result.GetProperty("diagnostics");
        var estimate = diagnostics.GetProperty("costEstimate");
        Assert.Equal("USD", estimate.GetProperty("currency").GetString());
        Assert.Equal(0.0749m, estimate.GetProperty("inputPricePerMillion").GetDecimal());
        Assert.Equal(0.44m, estimate.GetProperty("outputPricePerMillion").GetDecimal());
        Assert.Equal(0.000010486m, estimate.GetProperty("inputCost").GetDecimal());
        Assert.Equal(0.0000066m, estimate.GetProperty("outputCost").GetDecimal());
        Assert.Equal(0.000001m, estimate.GetProperty("requestCost").GetDecimal());
        Assert.Equal(0.000018086m, estimate.GetProperty("totalCost").GetDecimal());
        Assert.Equal(0.0000215m, diagnostics.GetProperty("usage").GetProperty("cost").GetDecimal());
        Assert.NotEqual(default, estimate.GetProperty("pricingFetchedAt").GetDateTimeOffset());
        Assert.Equal(1, handler.ProviderRequestCount);
    }

    [Theory]
    [InlineData(503, "{}")]
    [InlineData(200, "{")]
    [InlineData(200, "null")]
    [InlineData(200, """{"data":{"endpoints":[]}}""")]
    [InlineData(
        200,
        """{"data":{"endpoints":[{"provider_name":"Other","pricing":{"prompt":"1","completion":"1"}}]}}"""
    )]
    [InlineData(
        200,
        """{"data":{"endpoints":[{"provider_name":"Wafer","pricing":{"prompt":"-1","completion":"1"}}]}}"""
    )]
    [InlineData(200, """{"data":{"endpoints":[{"provider_name":"Wafer","pricing":{"prompt":"1"}}]}}""")]
    [InlineData(
        200,
        """{"data":{"endpoints":[{"provider_name":"Wafer","pricing":{"prompt":"1","completion":"1"}},{"provider_name":"Wafer","pricing":{"prompt":"2","completion":"1"}}]}}"""
    )]
    [InlineData(
        200,
        """{"data":{"endpoints":[{"provider_name":"Wafer","pricing":{"prompt":"1","completion":"1","overrides":[{}]}}]}}"""
    )]
    public async Task MissingInvalidOrAmbiguousPricingDoesNotDiscardTheResolution(int status, string body)
    {
        foreach (var version in new[] { "1", "4" })
        {
            await using var application = CreateApplication(
                new DeterministicServicesHandler
                {
                    PricingStatus = (HttpStatusCode)status,
                    PricingBody = body,
                    CaptureBody =
                        version == "4" ? CurrentViewCapture() : new DeterministicServicesHandler().CaptureBody,
                    ProviderBody = version == "4" ? BilledSelection() : null,
                }
            );
            using var client = application.CreateClient();
            using var response = await client.PostAsJsonAsync(
                "/pages/page-1/resolve",
                new
                {
                    instruction = "Click Save",
                    documentId = "document-1",
                    contractVersion = version,
                }
            );
            var result = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("found", result.GetProperty("outcome").GetString());
            Assert.Equal(JsonValueKind.Null, result.GetProperty("diagnostics").GetProperty("costEstimate").ValueKind);
            Assert.Equal(
                0.0000215m,
                result.GetProperty("diagnostics").GetProperty("usage").GetProperty("cost").GetDecimal()
            );
        }
    }

    [Theory]
    [InlineData("timeout")]
    [InlineData("network")]
    public async Task PricingLookupFailuresKeepSuccessfulResolutionAndUsage(string failure)
    {
        foreach (var version in new[] { "1", "4" })
        {
            await using var application = CreateApplication(
                new DeterministicServicesHandler
                {
                    CaptureBody =
                        version == "4" ? CurrentViewCapture() : new DeterministicServicesHandler().CaptureBody,
                    ProviderBody = version == "4" ? BilledSelection() : null,
                    BeforeRespondAsync = (path, _) =>
                        path.EndsWith("/endpoints", StringComparison.Ordinal)
                            ? Task.FromException(
                                failure == "timeout" ? new OperationCanceledException() : new HttpRequestException()
                            )
                            : Task.CompletedTask,
                }
            );
            using var client = application.CreateClient();
            using var response = await client.PostAsJsonAsync(
                "/pages/page-1/resolve",
                new
                {
                    instruction = "Click Save",
                    documentId = "document-1",
                    contractVersion = version,
                }
            );
            var result = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("found", result.GetProperty("outcome").GetString());
            Assert.Equal(JsonValueKind.Null, result.GetProperty("diagnostics").GetProperty("costEstimate").ValueKind);
        }
    }

    [Fact]
    public async Task ModelInputExcludesBrowserCapabilityIdentitiesAndCaptureBookkeeping()
    {
        var handler = new DeterministicServicesHandler();
        await using var application = CreateApplication(handler);
        using var client = application.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/pages/page-1/resolve",
            new { instruction = "Click Save", documentId = "document-1" }
        );
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var input = handler.ModelRequest.GetProperty("messages")[1].GetProperty("content").GetString()!;
        Assert.DoesNotContain("session-1", input, StringComparison.Ordinal);
        Assert.DoesNotContain("page-1", input, StringComparison.Ordinal);
        Assert.DoesNotContain("document-1", input, StringComparison.Ordinal);
        Assert.DoesNotContain("capture-1", input, StringComparison.Ordinal);
        Assert.DoesNotContain("capturedAt", input, StringComparison.Ordinal);
        Assert.DoesNotContain("coverage", input, StringComparison.Ordinal);
        Assert.Contains("button-save", input, StringComparison.Ordinal);
        Assert.Contains("Profile", input, StringComparison.Ordinal);
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
            new { instruction = "Click Save", documentId = "document-1" }
        );
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("error", result.GetProperty("outcome").GetString());
        Assert.Equal("invalid_browser_capture", result.GetProperty("diagnostics").GetProperty("code").GetString());
        Assert.Equal(0, handler.ProviderRequestCount);
    }

    private static string ProviderSelection(string selection) =>
        JsonSerializer.Serialize(
            new
            {
                id = "generation-1",
                choices = new[] { new { finish_reason = "stop", message = new { content = selection } } },
            }
        );

    private static WebApplicationFactory<HealthController> CreateApplication(
        DeterministicServicesHandler handler,
        Dictionary<string, string?>? settings = null,
        ILoggerProvider? logs = null
    ) =>
        new WebApplicationFactory<HealthController>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration(
                (_, configuration) =>
                    configuration
                        .AddInMemoryCollection(new Dictionary<string, string?> { ["OpenRouter:ApiKey"] = "test-token" })
                        .AddInMemoryCollection(settings ?? [])
            );
            builder.ConfigureServices(services =>
            {
                if (logs is not null)
                {
                    services.AddLogging(logging => logging.AddProvider(logs));
                }
                services.AddHttpClient("browser").ConfigurePrimaryHttpMessageHandler(() => handler);
                services.AddHttpClient("openrouter").ConfigurePrimaryHttpMessageHandler(() => handler);
            });
        });
}
