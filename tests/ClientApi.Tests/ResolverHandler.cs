using System.Net;
using System.Text;

namespace Xpathed.ClientApi.Tests;

internal sealed class ResolverHandler(HttpStatusCode status, string result) : HttpMessageHandler
{
    public HttpMethod? Method { get; private set; }
    public string? Path { get; private set; }
    public string? Body { get; private set; }
    public string? ContentType { get; private set; }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken
    )
    {
        Method = request.Method;
        Path = request.RequestUri?.AbsolutePath;
        Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
        ContentType = request.Content?.Headers.ContentType?.MediaType;
        return new HttpResponseMessage(status)
        {
            Content = new StringContent(result, Encoding.UTF8, "application/json"),
        };
    }
}
