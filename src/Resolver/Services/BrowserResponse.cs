using System.Text.Json;
using Xpathed.Common.Http;

namespace Xpathed.Resolver.Services;

internal static class BrowserResponse
{
    internal static async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }
        string? code = null;
        try
        {
            var body = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken);
            if (
                body.ValueKind == JsonValueKind.Object
                && body.TryGetProperty("code", out var value)
                && value.ValueKind == JsonValueKind.String
            )
            {
                code = value.GetString();
            }
        }
        catch (JsonException)
        {
            // Invalid error bodies contain no trustworthy diagnostic data.
        }
        code = code
            is "page_not_found"
                or "inactive_page"
                or "stale_document"
                or "stale_capture"
                or "stale_xpath_evidence"
                or "capture_budget_exceeded"
                or "capture_exposure_unknown"
                or "capture_incomplete"
                or "validation_budget_exceeded"
                or "unknown_candidate"
                or "xpath_validation_failed"
                or "invalid_action"
                or "invalid_actions"
                or "invalid_xpath_proposals"
            ? code
            : "browser_unavailable";
        throw new ApiException(
            (int)response.StatusCode,
            code,
            code switch
            {
                "inactive_page" => "The active tab changed. Resolve the instruction again.",
                "stale_capture" => "The page or current view changed. Resolve the instruction again.",
                "stale_xpath_evidence" =>
                    "Another selection replaced the target evidence. Resolve the instruction again.",
                _ => "The browser could not validate the current page and target.",
            }
        );
    }
}
