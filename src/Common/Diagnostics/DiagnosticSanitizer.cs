using System.Text.RegularExpressions;

namespace Xpathed.Common.Diagnostics;

public static partial class DiagnosticSanitizer
{
    public const string Redacted = "[redacted]";

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

    [GeneratedRegex(
        @"\b(password|passwd|secret|credential|authorization|cookie|api[_ -]?key|access[_ -]?token|bearer)\b|\bsk-[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    )]
    private static partial Regex Credentials();

    [GeneratedRegex("https?://[^\\s\\\"<>]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Url();
}
