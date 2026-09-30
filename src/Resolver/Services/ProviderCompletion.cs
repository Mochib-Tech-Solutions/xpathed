using Xpathed.Common.Contracts;

namespace Xpathed.Resolver.Services;

internal sealed record ProviderCompletion(string? Content, ResolutionDiagnostics Diagnostics);
