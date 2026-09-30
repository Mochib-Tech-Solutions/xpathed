using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Xpathed.ClientApi.Diagnostics;
using Xpathed.Common.Http;

namespace Xpathed.ClientApi.Controllers;

[ApiController]
[Route("internal/diagnostics")]
public sealed class DiagnosticsController(DiagnosticStore store) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] string? pageId,
        [FromQuery] string? traceId,
        [FromQuery] int limit = 100,
        CancellationToken cancellationToken = default
    )
    {
        EnsureOperatorAccess();
        return Ok(await store.ListAsync(pageId, traceId, limit, cancellationToken));
    }

    [HttpPost("import")]
    [RequestSizeLimit(2_000_000)]
    public async Task<IActionResult> Import([FromBody] JsonElement artifact, CancellationToken cancellationToken)
    {
        EnsureOperatorAccess();
        return Ok(await store.ImportAsync(artifact, cancellationToken));
    }

    [HttpPost("prune")]
    public async Task<IActionResult> Prune(CancellationToken cancellationToken)
    {
        EnsureOperatorAccess();
        return Ok(new { affected = await store.PruneAsync(cancellationToken) });
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken cancellationToken)
    {
        EnsureOperatorAccess();
        return await store.DeleteAsync(id, cancellationToken) == 0 ? NotFound() : NoContent();
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> Get(string id, CancellationToken cancellationToken)
    {
        EnsureOperatorAccess();
        var record = await store.GetAsync(id, cancellationToken);
        return record is null ? NotFound() : Ok(record);
    }

    private void EnsureOperatorAccess()
    {
        if (
            Request.Headers.ContainsKey("Origin")
            || HttpContext.Connection.RemoteIpAddress is { } address && !IPAddress.IsLoopback(address)
        )
        {
            throw new ApiException(
                403,
                "internal_only",
                "Diagnostics are available only through local operator access."
            );
        }
    }
}
