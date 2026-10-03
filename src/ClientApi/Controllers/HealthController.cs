using Microsoft.AspNetCore.Mvc;

namespace Xpathed.ClientApi.Controllers;

[ApiController]
[Route("health")]
public sealed class HealthController : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(new { service = "client-api" });
}
