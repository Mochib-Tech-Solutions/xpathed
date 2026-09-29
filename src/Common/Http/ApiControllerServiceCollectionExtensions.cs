using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Xpathed.Common.Contracts;

namespace Xpathed.Common.Http;

public static class ApiControllerServiceCollectionExtensions
{
    public static IMvcBuilder AddApiControllers(this IServiceCollection services) =>
        services.AddControllers().ConfigureApiBehaviorOptions(options =>
        {
            options.InvalidModelStateResponseFactory = context => new BadRequestObjectResult(
                new ApiError("invalid_request", "The request is invalid.", context.HttpContext.TraceIdentifier));
        });
}
