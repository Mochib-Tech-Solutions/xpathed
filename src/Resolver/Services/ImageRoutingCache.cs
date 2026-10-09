using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Caching.Memory;

namespace Xpathed.Resolver.Services;

public sealed class ImageRoutingCache : IDisposable
{
    internal const int EntryLimit = 256;
    internal const int LifetimeSeconds = 300;
    private readonly MemoryCache decisions = new(new MemoryCacheOptions { SizeLimit = EntryLimit });

    internal static string Key(string configurationId, string input) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(configurationId + "\n" + input)));

    internal bool TryGet(string key, out ImageRoutingDecision? decision) => decisions.TryGetValue(key, out decision);

    internal void Store(string key, ImageRoutingDecision decision)
    {
        if (decision.Reason is "semantic_evidence" or "visual_evidence")
        {
            // Cache only the classification: no instruction, page identity, target or pixels are retained.
            decisions.Set(
                key,
                decision,
                new MemoryCacheEntryOptions
                {
                    Size = 1,
                    AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(LifetimeSeconds),
                }
            );
        }
    }

    public void Dispose() => decisions.Dispose();
}
