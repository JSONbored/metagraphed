# Internal Root basket capture acceptance

`POST /api/v1/internal/root-basket-capture-sync` accepts one complete
`RootBasketCapture` observation. The edge forwards the request to the protected
receiver. `ROOT_BASKET_CAPTURE_SYNC_SECRET` is optional: without it the receiver
returns 503 and does not read the body or open storage. When configured, the
`x-root-basket-capture-sync-token` header must match it. This delivery does not
configure that secret, activate collection, schedule work, or expose a public
basket read route.

Apply migrations 0036 and 0037 before deploying the receiver. Its freshness
classification includes the completion table, but has no scheduled arrival
expectation until a producer is explicitly activated.

## Acceptance bounds

The receiver counts streamed bytes and rejects requests larger than **8,000,000
bytes**, even if `Content-Length` is absent or understates the body. Invalid
UTF-8, malformed JSON, missing parts, unsupported runtime/decoder versions,
duplicate keys, inconsistent counts and broken cursor chains are rejected.
Oversized input is rejected whole; it is never truncated into an observation.

The initial work ceilings are **256 page receipts, 2,048 funds, and 32,768 total
holding and target rows**. These limits and the byte cap are bounded defaults;
they have **not been sized against production captures**. A future collector
must measure complete capture sizes before activation and handle rejection
without publishing a partial capture.

Inserts use at most 1,000 rows per statement. Each batch uses four PostgreSQL
parameters through a typed JSON recordset, independently of its column count.
The bounds permit at most 41 statements inside the acceptance transaction,
followed by one receipt-identity read. No external RPC calls run in the receiver.

## Identity, completion and recovery

The existing source identity is network genesis hash, finalized block hash and
decoder version. A SHA-256 digest covers the schema-normalized observation:
network label and genesis, finalized hash and height, runtime and API versions,
decoder, metadata hash, index, every ordered page receipt, and every fund,
holding, target and baseline value. Object construction order and fund/child
array order do not alter the digest. Attempt UUID and start/finish timestamps
are excluded so the same observation can be retried without rewriting the first
accepted provenance.

One producer-store connection holds a transaction-scoped source/decoder lock,
checks replay identity, writes all row families, verifies persisted counts and
cursor continuity, and inserts an immutable completion receipt. A completeness
failure throws before commit. Completion freezes the observation and child
rows. Child mutations lock their parent capture before checking completion;
moving a child locks both parents in a stable order. This prevents a concurrent
child mutation from committing after a completion check. The receipt-ID read
after commit does not decide completeness.

An identical retry returns the first accepted capture ID and digest with
`replayed: true`; its attempt timestamps and acceptance time stay unchanged.
Changed content at the same source identity, a reused attempt ID for another
observation, an incomplete pre-existing observation, or a different finalized
hash at the same height is a 409 conflict. Conflicting observations require
investigation; retrying them cannot replace accepted data.

If simultaneous captures reuse one attempt UUID across different network-genesis
scopes, the losing transaction can initially return 503 from the UUID uniqueness
constraint. It commits no data. Retrying that same observation after the winning
commit resolves to 409; this first-response classification limit does not permit
overwriting the accepted capture.

The current pointer advances only to a greater finalized height within the same
network-genesis/decoder scope. Valid older captures can be retained as history
without regressing current data. A transaction failure rolls back all newly
written rows and preserves the previous current capture.

A 200 response contains `ok`, `capture_id`, `content_sha256` and `replayed`.
Authentication failures return 401, invalid captures 400, acceptance-budget
violations 413, and unavailable storage or unacknowledged writes 503. After a
503 or an interrupted response, retry the same observation: even if the earlier
transaction committed before its response was lost, replay resolves the
original receipt. Receipt acceptance confirms persisted observations and their
source metadata; it does not independently verify chain finality or valuation.

## Local verification

The portable PGlite tests execute both migrations and the same producer-store
transaction statements used by the receiver. They cover exact quantities,
batching, complete empty parts, stored-count/cursor corruption, rollback and
immutable replay through the protected Worker and edge proxy.

`tests/root-basket-capture-concurrency.test.ts` additionally uses PostgreSQL
server tools discovered through `pg_config --bindir`. As a non-root user with
those tools installed, it starts a disposable cluster on a temporary Unix
socket with TCP disabled, then verifies actual advisory-lock contention between
independent connections. Identical retries, conflicting data and source hashes,
late/newer captures, a failed first writer, and concurrent child mutations are
covered. The cluster is
removed after the tests. Hosts without server tools explicitly skip these eleven
cases; they still run the portable transaction and receiver suites.
