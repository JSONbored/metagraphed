# Public Finney RPC operation admission

Raw capture has two independent limits. Opentensor's measured allowance counts
HTTP requests, while OnFinality's public fallback counts each JSON-RPC operation
inside a batch. Its [batch documentation](https://documentation.onfinality.io/support/batch-requests)
describes a 50-operation public burst and rejects a complete batch when it would
exceed the allowance. The [public rate limits](https://documentation.onfinality.io/support/public-rate-limits)
also specify 3,000 HTTP response units per minute per IP.

On 2026-10-01, ordinary capture repeatedly stopped at mainnet block 9,186,859
with `batch(50): HTTP 429`. The existing chunk-start spacing did not separate a
chunk's hash lookup from its immediately following body/events batch. Treating
that pair as two HTTP requests leaves a full batch competing with the lookup's
operation allowance.

`chain-rpc-admission.ts` reserves operations before the shared transport sends
them. Single calls reserve one unit and batches reserve their exact member count.
The existing public Finney fallback permits at most 50 admitted operations in a
rolling second. All users of the shared transport in the same Worker isolate use
one reservation queue, including equivalent host casing, default port and trailing
slash spellings. Other providers and dedicated paths retain their existing limits.
The transport timeout starts after admission, so waiting for capacity cannot spend
the request's network deadline.

Admission retains every original method, parameter, request ID, batch member and
response. The contiguous capture prefix, immutable durable writes, required events
and watermark-after-storage ordering remain unchanged. It adds no network retry.

This removes self-inflicted burst overflow in this transport. A public provider's
availability and IP allowance shared with other isolates or unrelated clients are
external constraints. An actual transport rejection still stops capture at the
first missing height; it cannot be converted into a successful empty block or an
advanced watermark. Testnet header timeouts and missing retained history require
their own qualified recovery. Ordinary producer results are required before any
production incident is considered recovered.

The regressions model the provider's rolling operation allowance. HTTP-only
pacing stalls before its first durable write; operation admission captures three
whole chunks with all original fields. A provider that remains unavailable still
leaves storage and the watermark unchanged.
