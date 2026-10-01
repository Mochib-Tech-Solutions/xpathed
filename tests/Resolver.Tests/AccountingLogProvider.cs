using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;

namespace Xpathed.Resolver.Tests;

internal sealed class AccountingLogProvider : ILoggerProvider
{
    public ConcurrentQueue<IReadOnlyList<KeyValuePair<string, object?>>> Entries { get; } = new();
    public TaskCompletionSource Recorded { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public ILogger CreateLogger(string categoryName) => new Sink(this, categoryName);

    public void Dispose() { }

    private sealed class Sink(AccountingLogProvider owner, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter
        )
        {
            if (
                category.EndsWith(".ProviderAccounting", StringComparison.Ordinal)
                && state is IReadOnlyList<KeyValuePair<string, object?>> values
            )
            {
                owner.Entries.Enqueue(values.ToArray());
                owner.Recorded.TrySetResult();
            }
        }
    }
}
