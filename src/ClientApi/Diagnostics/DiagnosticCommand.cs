using System.Text.Json;
using Xpathed.Common.Http;

namespace Xpathed.ClientApi.Diagnostics;

public static class DiagnosticCommand
{
    public static async Task<int> RunAsync(
        DiagnosticStore store,
        string[] arguments,
        CancellationToken cancellationToken
    )
    {
        try
        {
            object result;
            switch (arguments)
            {
                case ["list"]:
                    result = await store.ListAsync(null, null, 100, cancellationToken);
                    break;
                case ["list", var pageId]:
                    result = await store.ListAsync(pageId, null, 100, cancellationToken);
                    break;
                case ["export", var id]:
                    result =
                        await store.GetAsync(id, cancellationToken)
                        ?? throw new ApiException(404, "record_not_found", "The diagnostic record is unavailable.");
                    break;
                case ["import"]:
                    using (var input = Console.OpenStandardInput())
                    {
                        var buffer = new byte[2_000_001];
                        var read = await input.ReadAtLeastAsync(buffer, buffer.Length, false, cancellationToken);
                        if (read == buffer.Length)
                        {
                            throw new ApiException(
                                413,
                                "artifact_too_large",
                                "Diagnostic imports are limited to 2 MB."
                            );
                        }
                        using var document = JsonDocument.Parse(buffer.AsMemory(0, read));
                        result = await store.ImportAsync(document.RootElement, cancellationToken);
                    }
                    break;
                case ["prune"]:
                    result = new { affected = await store.PruneAsync(cancellationToken) };
                    break;
                case ["delete", var id]:
                    var deleted = await store.DeleteAsync(id, cancellationToken);
                    if (deleted == 0)
                    {
                        throw new ApiException(404, "record_not_found", "The diagnostic record is unavailable.");
                    }
                    result = new { deleted };
                    break;
                default:
                    await Console.Error.WriteLineAsync(
                        "Usage: diagnostics list [pageId] | export <id> | import | prune | delete <id>"
                    );
                    return 1;
            }
            await Console.Out.WriteLineAsync(JsonSerializer.Serialize(result, DiagnosticStore.JsonOptions));
            return 0;
        }
        catch (Exception error)
        {
            var code = error switch
            {
                ApiException failure => failure.Code,
                JsonException => "invalid_json",
                OperationCanceledException => "cancelled",
                _ => "diagnostic_command_failed",
            };
            // Operational exceptions can contain connection strings or input fragments.
            await Console.Error.WriteLineAsync(JsonSerializer.Serialize(new { code }, DiagnosticStore.JsonOptions));
            return 1;
        }
    }
}
