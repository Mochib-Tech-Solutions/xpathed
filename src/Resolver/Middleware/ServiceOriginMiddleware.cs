using Xpathed.Common.Http;

namespace Xpathed.Resolver.Middleware;

internal sealed class ServiceOriginMiddleware(RequestDelegate next)
{
    public Task InvokeAsync(HttpContext context)
    {
        if (context.Request.Headers.ContainsKey("Origin"))
        {
            throw new ApiException(403, "invalid_origin", "Resolver requests must come from the client API or a service client.");
        }

        return next(context);
    }
}
