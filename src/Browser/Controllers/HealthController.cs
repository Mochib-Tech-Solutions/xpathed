using Microsoft.AspNetCore.Mvc;

namespace Xpathed.Browser.Controllers;

[ApiController]
[Route("health")]
public sealed class HealthController : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(new { service = "browser" });
}
