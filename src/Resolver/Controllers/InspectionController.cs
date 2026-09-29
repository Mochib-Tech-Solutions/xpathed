using Microsoft.AspNetCore.Mvc;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Resolver.Controllers;

[ApiController]
[Route("pages")]
public sealed class InspectionController(IHttpClientFactory clients) : ControllerBase
{
    [HttpPost("{pageId}/inspect")]
    public async Task<ActionResult<InspectionResult>> Inspect(string pageId, CancellationToken cancellationToken)
    {
        using var response = await clients.CreateClient("browser").GetAsync($"/pages/{Uri.EscapeDataString(pageId)}/inspection", cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            return new ContentResult
            {
                StatusCode = (int)response.StatusCode,
                ContentType = response.Content.Headers.ContentType?.ToString() ?? "application/json",
                Content = await response.Content.ReadAsStringAsync(cancellationToken)
            };
        }

        var page = await response.Content.ReadFromJsonAsync<PageInspection>(cancellationToken)
            ?? throw new ApiException(502, "invalid_upstream_response", "The browser returned an invalid inspection.");
        return new InspectionResult("resolver", page);
    }
}
