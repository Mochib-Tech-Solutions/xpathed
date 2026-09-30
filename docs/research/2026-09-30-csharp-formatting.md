# Enforce C# line wrapping

Checked on 2026-09-30 for the requested cleanup of long record declarations and expressions.

Microsoft's [C# formatting options](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/style-rules/csharp-formatting-options) expose single-line block/statement preservation, but no line-width wrapping option. [dotnet format](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-format) separates whitespace, style and analyzer fixes. Setting `max_line_length` alone therefore does not make its whitespace check reject a long positional record.

Use a pinned local CSharpier tool for whitespace rather than writing a partial C# parser. Its [configuration](https://csharpier.com/docs/Configuration) reads `max_line_length` from `.editorconfig`; its [CLI](https://csharpier.com/docs/CLI) provides a non-mutating check and validates syntax-tree equivalence during formatting. Version 1.3.0 was the current [published package](https://www.nuget.org/packages/CSharpier/1.3.0) when checked.

The repository uses a 120-column print target, four-space C# indentation and existing LF settings. The target is deliberately not a hard line-length limit: indivisible strings, raw embedded scripts and comments can exceed it. CSharpier owns whitespace; IDE0055 is disabled to avoid competing formatters, while `dotnet format style`, build analyzers and warnings-as-errors remain active. XML project files retain their existing layout through `.csharpierignore`.

Local formatting and CI restore the manifest-pinned tool and check the same C# output. Change selection includes the tool manifest and ignore file. Test projects receive the same formatter check as service projects.
