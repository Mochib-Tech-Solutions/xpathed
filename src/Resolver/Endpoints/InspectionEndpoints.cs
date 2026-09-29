using Xpathed.Common.Contracts;

namespace Xpathed.Resolver.Endpoints;

internal static class InspectionEndpoints
{
    public static void MapInspectionEndpoints(this WebApplication app)
    {
        app.MapPost("/pages/{pageId}/inspect", async (string pageId, HttpContext context, IHttpClientFactory clients) =>
        {
            using var response = await clients.CreateClient("browser").GetAsync($"/pages/{Uri.EscapeDataString(pageId)}/inspection", context.RequestAborted);
            if (!response.IsSuccessStatusCode)
            {
                context.Response.StatusCode = (int)response.StatusCode;
                context.Response.ContentType = "application/json";
                await response.Content.CopyToAsync(context.Response.Body, context.RequestAborted);
                return;
            }
            var page = await response.Content.ReadFromJsonAsync<PageInspection>(context.RequestAborted);
            await context.Response.WriteAsJsonAsync(new InspectionResult("resolver", page!), context.RequestAborted);
        });
    }
}
