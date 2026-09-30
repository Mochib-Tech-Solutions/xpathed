using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Xpathed.Common.Diagnostics;

public static partial class DiagnosticSanitizer
{
    public const string Redacted = "[redacted]";

    public static bool IsSensitiveInstruction(string instruction) => SensitiveInstruction().IsMatch(instruction);

    public static bool IsSensitiveAction(string? action) => action is "fill" or "type" or "upload";

    public static string RedactInstruction(string instruction) =>
        IsSensitiveInstruction(instruction) ? Redacted : SanitizeText(instruction)!;

    public static string? SanitizeText(string? value)
    {
        if (value is null)
        {
            return null;
        }
        if (Credentials().IsMatch(value))
        {
            return Redacted;
        }
        return Url()
            .Replace(
                value,
                match =>
                    Uri.TryCreate(match.Value, UriKind.Absolute, out var uri)
                        ? new UriBuilder(uri)
                        {
                            UserName = "",
                            Password = "",
                            Query = "",
                            Fragment = "",
                        }
                            .Uri
                            .AbsoluteUri
                        : Redacted
            );
    }

    public static string SanitizeJson(string json, string? instruction = null)
    {
        var node = JsonNode.Parse(json) ?? throw new JsonException("A diagnostic document is required.");
        if (node is not (JsonObject or JsonArray))
        {
            throw new JsonException("A diagnostic document must be an object or array.");
        }
        var sensitive = instruction is not null && IsSensitiveInstruction(instruction) || HasSensitiveContent(node);
        Visit(node, null);
        return node.ToJsonString();

        void Visit(JsonNode current, string? key, int depth = 0)
        {
            key = key?.ToLowerInvariant();
            if (depth >= 32)
            {
                current.ReplaceWith(Redacted);
                return;
            }
            if (current is JsonObject properties)
            {
                foreach (var property in properties.ToArray())
                {
                    if (SecretProperty().IsMatch(property.Key))
                    {
                        properties[property.Key] = Redacted;
                    }
                    else if (property.Value is { } child)
                    {
                        Visit(child, property.Key, depth + 1);
                    }
                }
            }
            else if (current is JsonArray array)
            {
                foreach (var child in array.ToArray())
                {
                    if (child is not null)
                    {
                        Visit(child, key, depth + 1);
                    }
                }
            }
            else if (current is JsonValue value && value.TryGetValue<string>(out var text))
            {
                if (
                    sensitive
                    && key
                        is "instruction"
                            or "label"
                            or "labels"
                            or "text"
                            or "scope"
                            or "placeholder"
                            or "xpaths"
                            or "xpath"
                            or "modelinput"
                            or "message"
                )
                {
                    current.ReplaceWith(Redacted);
                }
                else if (key is "modelinput" or "configurationjson")
                {
                    var nested = ParseEvidenceJson(text);
                    if (nested is null || depth >= 31)
                    {
                        current.ReplaceWith(Redacted);
                    }
                    else
                    {
                        Visit(nested, null, depth + 1);
                        current.ReplaceWith(nested.ToJsonString());
                    }
                }
                else
                {
                    current.ReplaceWith(SanitizeText(text));
                }
            }
        }
    }

    private static JsonNode? ParseEvidenceJson(string text)
    {
        try
        {
            var node = JsonNode.Parse(text);
            return node is JsonObject or JsonArray ? node : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static bool HasSensitiveContent(JsonNode? node, int depth = 0)
    {
        if (depth >= 32)
        {
            return true;
        }
        return node switch
        {
            JsonObject properties => properties.Any(property =>
                property.Value is JsonValue value
                    && value.TryGetValue<string>(out var text)
                    && (
                        property.Key.Equals("action", StringComparison.OrdinalIgnoreCase) && IsSensitiveAction(text)
                        || property.Key.Equals("instruction", StringComparison.OrdinalIgnoreCase)
                            && IsSensitiveInstruction(text)
                        || property.Key.ToLowerInvariant() is "modelinput" or "configurationjson"
                            && HasSensitiveContent(ParseEvidenceJson(text), depth + 1)
                    )
                || HasSensitiveContent(property.Value, depth + 1)
            ),
            JsonArray array => array.Any(child => HasSensitiveContent(child, depth + 1)),
            _ => false,
        };
    }

    [GeneratedRegex(
        @"\b(fill|type|append|upload|enter|replace|set|paste|write|password|secret|credential|token|api.?key)\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    )]
    private static partial Regex SensitiveInstruction();

    [GeneratedRegex(
        @"\b(password|passwd|secret|credential|authorization|cookie|api[_ -]?key|access[_ -]?token|bearer)\b|\bsk-[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    )]
    private static partial Regex Credentials();

    [GeneratedRegex(
        @"^(password|passwd|secret|credentials?|authorization|cookie|cookies|api[_-]?key|access[_-]?token|refresh[_-]?token|connectionString|storage|localStorage|sessionStorage|value|values|html|raw[_-]?dom|dom|body|headers|requestHeaders|responseHeaders|raw[_-]?response)$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    )]
    private static partial Regex SecretProperty();

    [GeneratedRegex("https?://[^\\s\\\"<>]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Url();
}
