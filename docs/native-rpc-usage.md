# Native RPC usage preparation

`createPgRpcUsageStore` provides the explicitly selected `RPC_USAGE_STORE`
capability. The existing public and fullnode proxy callers send it the same
normalized event they send Analytics Engine today. A selected native capability
does not fall back to Cloudflare when a write is rejected or a read fails.
Existing Worker defaults are unchanged.

The synchronous `record` method enqueues an immutable event with a generated UUID.
It performs no database or network operation. Admission is bounded by both rows
and bytes, and each flush writes at most the configured batch size. `stats()`
reports accepted, persisted, rejected, failed batches, pending rows and bytes.
Acceptance means in-memory admission, not durable commit: an abrupt process loss
can lose pending telemetry, as it can with the existing platform handoff. The
process owner must call and monitor `flush`, schedule bounded `prune` calls, and
await `close` before closing its shared PostgreSQL pool. Construction starts no
timers, listeners or deployments. Failed and uncertain commits retain their
original event IDs so a retry cannot double-count a committed batch. Failed drain
retains pending rows and reports failure; it does not certify a clean shutdown.

Apply `0038_rpc_usage.sql` to the prepared single database before selecting the
capability. The same process-owned runtime supplies reads and writes. Identity
strings use JSON string text so PostgreSQL does not normalize or reject embedded
NUL or lone surrogates. No request payload, client address, credential or account
identity is captured. Public usage responses continue excluding the fullnode
pool. Five bounded rollups use one repeatable-read snapshot; weighted percentiles
use the existing continuous weighted percentile implementation and real latency
observations. These exact percentiles need not equal Analytics Engine's
approximation. The common formatter and historical artifact fallback remain in
use; coverage names the actual `postgresql` source.

Retention is explicitly configured between 31 and 93 days; each prune removes at
most 10,000 expired events. Configure finite execution and drain deadlines and a
pool statement timeout. Histogram reads reject more than 100,000 distinct latency
values rather than silently publishing a partial distribution. Capacity and
retention require measured qualification before production selection.

Before switching owners, preserve the required Analytics Engine history and its
sampling weights, establish a timestamp boundary without overlap or gaps against
the immutable historical files, and reconcile counts and public response windows.
Then switch capture and reads together and verify freshness before retiring the
old writer. This change does not perform that transfer, schedule a flush loop,
start a native process, or remove any Cloudflare resource.
