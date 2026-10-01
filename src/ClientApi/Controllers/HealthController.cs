using Microsoft.AspNetCore.Mvc;
using Xpathed.ClientApi.Data;

namespace Xpathed.ClientApi.Controllers;

[ApiController]
[Route("health")]
public sealed class HealthController(AppDbContext database) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken cancellationToken) =>
        await database.Database.CanConnectAsync(cancellationToken)
            ? Ok(
                new
                {
                    service = "client-api",
                    database = "connected",
                    resolutionContract = "4",
                }
            )
            : StatusCode(StatusCodes.Status503ServiceUnavailable);
}
