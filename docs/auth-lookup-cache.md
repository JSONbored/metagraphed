# Authentication lookup cache lifetimes

API-key verification and OAuth account-tier lookups share a small envelope
policy in `src/auth-lookup-cache.ts`. Workers KV requires an `expirationTtl`
of at least 60 seconds. Both lookups retain their existing 30-second negative
retry lifetime inside the record while storing it for 60 seconds.

| Lookup             | Positive lifetime | Negative lifetime | Physical negative TTL |
| ------------------ | ----------------- | ----------------- | --------------------- |
| Managed API key    | 1,800 seconds     | 30 seconds        | 60 seconds            |
| Unmanaged API key  | No positive cache | 30 seconds        | 60 seconds            |
| OAuth account tier | 300 seconds       | 30 seconds        | 60 seconds            |

Readers reject an envelope at its exact logical expiry, regardless of whether
KV still returns its physical entry. Invalid versions, timestamps, lifetimes,
or `found` flags also cause a fresh lookup. Public validation response bodies
remain unchanged. A KV read failure falls through to the service
binding; a write failure retains that lookup's result. Lookup failures use
the existing negative result and retry policy.

The envelope is written under `api-key-lookup:v3:<sha256>` or
`oauth-account-tier:v2:<account-id>`. API keys remain locally SHA-256 hashed
in storage keys; raw credentials are never included in these cache values.
Legacy namespaces are ignored so a rolling deployment cannot interpret an
envelope as a raw identity record. Their existing entries expire normally.
This version change causes one cold lookup per identity at rollout.

Both outcomes replace the same key. An observed rejection can therefore
replace a previously stored grant, and a later successful lookup can replace
a negative answer. Unlike observational RPC caches, authentication lookups
do not give successful answers precedence over rejections. Lifetimes start
when the lookup completes and the envelope is constructed. Concurrent
lookups retain completion-order writes; timestamps do not establish which
authorization observation is newer at its source.

Workers KV remains eventually consistent and concurrent writes remain
last-write-wins. Managed API-key envelopes include the provider key ID and
the verified account ID. Every reuse requires a successful internal ledger
state check bound to those IDs, so a stale positive cache cannot override a
committed local revocation. The state query must use the cache-disabled
Hyperdrive resource and is never stored in KV. Missing bindings, malformed
state responses, or state lookup failures deny access for that request.
Requests whose state check finished before a revocation commits may finish;
this does not cancel work already authorized. A late cache write still needs
a fresh state check when another request reads it.

A genuinely unmanaged credential has no local ledger row. It requires fresh
provider verification on every request, followed by a ledger check; that
verification never inserts a trusted ledger record. A missing row discovered
while checking a managed cached identity also forces this fresh verification.

Provider-side disable, deletion, expiry changes, and tier changes for managed
keys still depend on the existing 30-minute provider refresh. The negative
lifetime controls retries after a rejection has actually been observed.
Account blocks, rate limits, and quota checks remain the responsibility of
each request path, outside the identity cache. An account block is distinct
from revoking an individual API key.

Deploy the internal verification/state capability before this reader. The
new namespace intentionally ignores older records without key ownership
metadata. Durable pending-intent activation follows deployment of all edge
readers and the compatible account settings UI. See [API key state](api-key-state.md)
for the staged deployment and pending-state contract.

Provider references: [KV write parameters and concurrent writes](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)
and [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
