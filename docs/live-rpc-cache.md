# Live-reader cache and retry windows

Live readers use `src/live-rpc-cache.ts` to keep logical retry windows separate
from physical storage expiration. Workers KV requires an `expirationTtl` of at
least 60 seconds. A failure retained for 60 seconds must not turn a 10-second
retry window into a minute of unavailable data. The shared writer persists a
versioned envelope with an absolute logical expiry; the reader treats that
envelope as a miss at the expiry boundary even while KV still holds it.
These are shared-reader cache windows; HTTP response-cache policies remain a
separate layer.

| Reader                             | Successful observation | Failure retry window |
| ---------------------------------- | ---------------------: | -------------------: |
| Account balance                    |                    60s |                  10s |
| Legacy Root claim                  |                   120s |                  10s |
| Address mapping                    |                  3600s |                  10s |
| Chain burn                         |                   120s |                  10s |
| Child/parent delegation            |                   120s |                  10s |
| Crowdloan detail                   |                   120s |                  10s |
| Network parameters                 |                   300s |                  10s |
| Randomness                         |                    30s |                  10s |
| Subnet burn                        |                   120s |                  10s |
| Subnet lease                       |                   120s |                  10s |
| Subnet conviction                  |                    60s |                  10s |
| Subnet recycled registration count |                   600s |                  10s |
| Sudo key                           |                  3600s |                  10s |
| Upgrade radar                      |                   300s |                  30s |

Failures are written to `<existing-key>:failure:v1`. They cannot overwrite the
successful observation at the existing key, including when an overlapping
request fails after another request has recovered. Readers prefer the successful
observation for its existing cache lifetime. This policy uses separate keys
because KV offers no conditional compare-and-swap write. It does not rely on a
read-before-write race check or on deleting a failure after success.

Successful bodies retain their existing keys and shapes. Legacy failure writes
with unsupported 10s/30s expiration could not persist on Workers KV. Randomness
also had an unsupported 30s **success** expiration; its new `network:randomness:v2`
namespace holds an envelope with a 30s logical lifetime and 60s physical expiry,
so old readers cannot mistake that envelope for a public response.

Network prefixes remain part of both keys. Legacy Root-claim compatibility still
checks the finalized head and runtime before looking in the cache, and applies
the same runtime predicate to successful and failed observations. A negative
cache hit suppresses its storage reads, not these mandatory compatibility checks.
The network-parameter freshness reader continues to read only the successful
key without making an RPC call. A recent failed attempt cannot advance the
freshness timestamp or mark unavailable data current. Request cache hits retain
the original timestamps, nulls, empty results and status reasons; envelopes never
enter REST, GraphQL or MCP response bodies.

Expired or malformed failure envelopes are misses. Read and write failures remain
non-fatal through each reader's existing fallback. The crowdloan directory still
does not cache a degraded result; its detail reader uses the shared policy. The
upgrade radar's separately captured release sources retain their existing policy.
Authentication lookup caches are outside this live-reader change.

KV remains eventually consistent. A failure may not immediately reach another
location, so this is best-effort suppression rather than a global request lock.
Propagation delay cannot extend an envelope's absolute logical expiry. No
production RPC requests are needed to validate these semantics: the hermetic
suite rejects provider-invalid writes, exercises logical and physical boundaries,
and verifies recovery and overlapping success/failure writes.

Provider references: [KV write and concurrent-write semantics](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)
and [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
