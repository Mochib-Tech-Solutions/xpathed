using System.Threading.RateLimiting;
using Xpathed.Common.Http;

namespace Xpathed.Resolver.Services;

public sealed class ModelUsageLimits : IDisposable
{
    private readonly PartitionedRateLimiter<bool> limiter;
    public int ConcurrentCalls { get; }
    public int CallsPerMinute { get; }
    public int CallsPerDay { get; }

    public ModelUsageLimits(IConfiguration configuration)
    {
        ConcurrentCalls = configuration.GetValue("ModelUsage:ConcurrentCalls", 2);
        CallsPerMinute = configuration.GetValue("ModelUsage:CallsPerMinute", 20);
        CallsPerDay = configuration.GetValue("ModelUsage:CallsPerDay", 1000);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(ConcurrentCalls);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(CallsPerMinute);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(CallsPerDay);
        limiter = PartitionedRateLimiter.CreateChained(
            PartitionedRateLimiter.Create<bool, string>(_ =>
                RateLimitPartition.GetConcurrencyLimiter(
                    "model",
                    _ => new ConcurrencyLimiterOptions { PermitLimit = ConcurrentCalls, QueueLimit = 0 }
                )
            ),
            PartitionedRateLimiter.Create<bool, string>(_ =>
                RateLimitPartition.GetFixedWindowLimiter(
                    "minute",
                    _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = CallsPerMinute,
                        Window = TimeSpan.FromMinutes(1),
                        QueueLimit = 0,
                    }
                )
            ),
            PartitionedRateLimiter.Create<bool, string>(_ =>
                RateLimitPartition.GetFixedWindowLimiter(
                    "day",
                    _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = CallsPerDay,
                        Window = TimeSpan.FromDays(1),
                        QueueLimit = 0,
                    }
                )
            )
        );
    }

    internal RateLimitLease Acquire()
    {
        var lease = limiter.AttemptAcquire(true);
        if (lease.IsAcquired)
        {
            return lease;
        }
        using (lease)
        {
            var seconds = lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter)
                ? Math.Max(1, Math.Ceiling(retryAfter.TotalSeconds))
                : 1;
            throw new ApiException(
                429,
                "model_usage_limited",
                $"The shared model usage limit was reached. Try again in {seconds} seconds."
            );
        }
    }

    public void Dispose() => limiter.Dispose();
}
