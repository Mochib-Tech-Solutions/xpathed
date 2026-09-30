using Xpathed.Common.Http;

namespace Xpathed.ClientApi.Middleware;

internal sealed class SameOriginMiddleware(RequestDelegate next)
{
    public Task InvokeAsync(HttpContext context)
    {
        if (
            context.Request.Headers.TryGetValue("Origin", out var origin)
            && origin != $"{context.Request.Scheme}://{context.Request.Host}"
        )
        {
            throw new ApiException(403, "invalid_origin", "This origin is not allowed.");
        }

        return next(context);
    }
}
