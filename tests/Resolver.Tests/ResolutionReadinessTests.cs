using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using static Xpathed.Resolver.Tests.DeterministicServicesHandler;
using static Xpathed.Resolver.Tests.ResolverTestApplication;

namespace Xpathed.Resolver.Tests;

public sealed class ResolutionReadinessTests
{
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
}
