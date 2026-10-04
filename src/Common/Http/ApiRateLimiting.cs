using System.Diagnostics;
using System.Globalization;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xpathed.Common.Contracts;

namespace Xpathed.Common.Http;

public static class ApiRateLimiting
{
    public static void AddApiRateLimits(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddRateLimiter(options =>
        {
            var concurrent = configuration.GetValue("RateLimits:ConcurrentRequests", 8);
            var perMinute = configuration.GetValue("RateLimits:RequestsPerMinute", 120);
            ArgumentOutOfRangeException.ThrowIfNegativeOrZero(concurrent);
            ArgumentOutOfRangeException.ThrowIfNegativeOrZero(perMinute);
            options.GlobalLimiter = PartitionedRateLimiter.CreateChained(
                PartitionedRateLimiter.Create<HttpContext, string>(context =>
                    context.Request.Path.Equals("/health", StringComparison.OrdinalIgnoreCase)
                        ? RateLimitPartition.GetNoLimiter("health")
                        : RateLimitPartition.GetConcurrencyLimiter(
                            "api",
                            _ => new ConcurrencyLimiterOptions { PermitLimit = concurrent, QueueLimit = 0 }
                        )
                ),
                PartitionedRateLimiter.Create<HttpContext, string>(context =>
                    context.Request.Path.Equals("/health", StringComparison.OrdinalIgnoreCase)
                        ? RateLimitPartition.GetNoLimiter("health")
                        : RateLimitPartition.GetFixedWindowLimiter(
                            "api",
                            _ => new FixedWindowRateLimiterOptions
                            {
                                PermitLimit = perMinute,
                                Window = TimeSpan.FromMinutes(1),
                                QueueLimit = 0,
                            }
                        )
                )
            );
            options.OnRejected = async (rejection, token) =>
            {
                var context = rejection.HttpContext;
                var seconds = rejection.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter)
                    ? Math.Max(1, Math.Ceiling(retryAfter.TotalSeconds))
                    : 1;
                context.Response.StatusCode = StatusCodes.Status429TooManyRequests;
                context.Response.Headers.RetryAfter = seconds.ToString(CultureInfo.InvariantCulture);
                await context.Response.WriteAsJsonAsync(
                    new ApiError(
                        "request_rate_limited",
                        $"The backend request limit was reached. Try again in {seconds} seconds.",
                        Activity.Current?.TraceId.ToString() ?? context.TraceIdentifier
                    ),
                    token
                );
            };
        });
    }
}
