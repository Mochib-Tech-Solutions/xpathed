using Microsoft.AspNetCore.Mvc;
using Xpathed.ClientApi.Diagnostics;
using Xpathed.ClientApi.Http;
using Xpathed.Common.Contracts;

namespace Xpathed.ClientApi.Controllers;

[ApiController]
[Route("api/pages")]
public sealed class PagesController(IHttpClientFactory clients, ResolutionRecorder recorder) : ControllerBase
{
    [HttpGet("{id}")]
    public Task Get(string id) =>
        HttpForwarder.ForwardAsync(HttpContext, clients.CreateClient("browser"), $"/pages/{Uri.EscapeDataString(id)}");

    [HttpPost("{id}/activate")]
    public Task Activate(string id) =>
        HttpForwarder.ForwardAsync(
            HttpContext,
            clients.CreateClient("browser"),
            $"/pages/{Uri.EscapeDataString(id)}/activate"
        );

    [HttpDelete("{id}")]
    public Task Delete(string id) =>
        HttpForwarder.ForwardAsync(HttpContext, clients.CreateClient("browser"), $"/pages/{Uri.EscapeDataString(id)}");

    [HttpPost("{id}/navigate")]
    public Task Navigate(string id) =>
        HttpForwarder.ForwardAsync(
            HttpContext,
            clients.CreateClient("browser"),
            $"/pages/{Uri.EscapeDataString(id)}/navigate"
        );

    [HttpPost("{id}/resolve")]
    public Task<ResolutionResult> Resolve(string id, ResolutionRequest request, CancellationToken cancellationToken) =>
        recorder.ResolveAsync(id, request, cancellationToken);

    [HttpPost("{id}/highlight")]
    public Task InspectAction(string id) =>
        HttpForwarder.ForwardAsync(
            HttpContext,
            clients.CreateClient("browser"),
            $"/pages/{Uri.EscapeDataString(id)}/highlight"
        );

    [HttpPost("{id}/inspect")]
    public Task Inspect(string id) =>
        HttpForwarder.ForwardAsync(
            HttpContext,
            clients.CreateClient("resolver"),
            $"/pages/{Uri.EscapeDataString(id)}/inspect"
        );
}
