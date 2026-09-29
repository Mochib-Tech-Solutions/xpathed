using Microsoft.AspNetCore.Mvc;

namespace Xpathed.Resolver.Controllers;

[ApiController]
[Route("health")]
public sealed class HealthController : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(new { service = "resolver" });
}
