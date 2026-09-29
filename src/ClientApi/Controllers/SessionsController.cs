using Microsoft.AspNetCore.Mvc;
using Xpathed.ClientApi.Http;

namespace Xpathed.ClientApi.Controllers;

[ApiController]
[Route("api/sessions")]
public sealed class SessionsController(IHttpClientFactory clients) : ControllerBase
{
    [HttpPost]
    public Task Create() => HttpForwarder.ForwardAsync(HttpContext, clients.CreateClient("browser"), "/sessions");

    [HttpDelete("{id}")]
    public Task Delete(string id) =>
        HttpForwarder.ForwardAsync(HttpContext, clients.CreateClient("browser"), $"/sessions/{Uri.EscapeDataString(id)}");
}
