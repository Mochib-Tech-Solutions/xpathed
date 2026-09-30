using Microsoft.AspNetCore.Mvc;
using Xpathed.ClientApi.Http;

namespace Xpathed.ClientApi.Controllers;

[ApiController]
[Route("api/sessions")]
public sealed class SessionsController(IHttpClientFactory clients) : ControllerBase
{
    [HttpPost]
    public Task Create() => HttpForwarder.ForwardAsync(HttpContext, clients.CreateClient("browser"), "/sessions");

    [HttpGet("{id}")]
    public Task Get(string id) =>
        HttpForwarder.ForwardAsync(
            HttpContext,
            clients.CreateClient("browser"),
            $"/sessions/{Uri.EscapeDataString(id)}"
        );

    [HttpPost("{id}/pages")]
    public Task CreatePage(string id) =>
        HttpForwarder.ForwardAsync(
            HttpContext,
            clients.CreateClient("browser"),
            $"/sessions/{Uri.EscapeDataString(id)}/pages"
        );

    [HttpDelete("{id}")]
    public Task Delete(string id) =>
        HttpForwarder.ForwardAsync(
            HttpContext,
            clients.CreateClient("browser"),
            $"/sessions/{Uri.EscapeDataString(id)}"
        );
}
