namespace Xpathed.ClientApi.Http;

internal static class HttpForwarder
{
    public static async Task ForwardAsync(HttpContext context, HttpClient client, string path)
    {
        using var request = new HttpRequestMessage(new HttpMethod(context.Request.Method), path);
        if (
            context.Request.ContentLength > 0
            || context.Request.ContentType is not null
            || context.Request.Headers.ContainsKey("Transfer-Encoding")
        )
        {
            request.Content = new StreamContent(context.Request.Body);
            if (context.Request.ContentType is { } contentType)
            {
                request.Content.Headers.TryAddWithoutValidation("Content-Type", contentType);
            }
        }
        using var response = await client.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            context.RequestAborted
        );
        context.Response.StatusCode = (int)response.StatusCode;
        context.Response.ContentType = response.Content.Headers.ContentType?.ToString();
        await response.Content.CopyToAsync(context.Response.Body, context.RequestAborted);
    }
}
