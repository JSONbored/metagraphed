# Authentication lookup cache lifetimes

API-key verification and OAuth account-tier lookups share a small envelope
policy in `src/auth-lookup-cache.ts`. Workers KV requires an `expirationTtl`
of at least 60 seconds. Both lookups retain their existing 30-second negative
retry lifetime inside the record while storing it for 60 seconds.

| Lookup               | Positive lifetime | Negative lifetime | Physical negative TTL |
| -------------------- | ----------------- | ----------------- | --------------------- |
| API-key verification | 1,800 seconds     | 30 seconds        | 60 seconds            |
| OAuth account tier   | 300 seconds       | 30 seconds        | 60 seconds            |

Readers reject an envelope at its exact logical expiry, regardless of whether
KV still returns its physical entry. Invalid versions, timestamps, lifetimes,
or `found` flags also cause a fresh lookup. Record fields and public response
bodies remain unchanged. A KV read failure falls through to the service
binding; a write failure retains that lookup's result. Lookup failures use
the existing negative result and retry policy.

The envelope is written under `api-key-lookup:v2:<sha256>` or
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

This change does not add atomic ordering or immediate revocation. Workers KV
is eventually consistent and concurrent writes remain last-write-wins.
A valid API-key verification may be reused for its existing 30-minute
lifetime; the negative lifetime only controls retries after a rejection has
actually been observed. Account blocks, rate limits, and quota checks remain
the responsibility of each request path, outside the identity cache. An
account block is distinct from revoking an individual API key.

Provider references: [KV write parameters and concurrent writes](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)
and [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
