using Xpathed.Common.Http;

namespace Xpathed.Browser.Middleware;

internal sealed class BrowserOriginMiddleware(RequestDelegate next)
{
    public Task InvokeAsync(HttpContext context)
    {
        if ((context.Request.Path.StartsWithSegments("/sessions") || context.Request.Path.StartsWithSegments("/pages")) &&
            context.Request.Headers.ContainsKey("Origin"))
        {
            throw new ApiException(403, "invalid_origin", "Browser control is available through the client API.");
        }

        return next(context);
    }
}
