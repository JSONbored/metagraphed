# Native neuron capture preparation

`NEURON_CAPTURE_STORE` explicitly selects the atomic native writer used by
forward neuron sync, historical backfill and queued neuron delivery. Selecting
it moves the complete write family together: current documents/members, daily
documents/members, account-position history and capture/pass receipts. A native
failure never falls through to another database.

`createPgNeuronCaptureStore` uses the process-owned PostgreSQL runtime and pinned
in-memory SQLite document codec. PostgreSQL owns every persistent row. The codec
only evaluates fixed expressions over bounded binary JSON; it creates no local
database file. Document merge, per-member timestamp comparison and prune use the
same SQLite expressions as the source writer. Equal and older captures retain
the accepted document values, while missing members in delayed captures can
still be added.

The writer acquires the existing neuron/closed-day advisory lock before reading
any document. One READ COMMITTED transaction writes the new decoder receipts,
source payloads, membership identities, axon effects, closed-day revisions and
capture receipt. Backfill carries no current-state rows or prune cutoffs. A
replayed capture can update neither its pass tally twice nor another capture's
content identity. Losing the commit response is an error; the caller may safely
redeliver the same capture using its durable identity.

The constructor requires row, document, payload, concurrent-work and deadline
budgets. Cancellation is checked between operations; a transaction that has
already reached commit can have an uncertain result and must be retried by its
identity. Work that has not finished keeps its admission slot, and process
shutdown must drain the writer before closing the shared codec or pool.

These are preparation components. They do not activate a writer, move source
data, allocate storage or change any production service. Source custody, complete
read-path coverage, deployment composition and a full restore/cutover rehearsal
remain separate acceptance requirements.

Member identity columns still use PostgreSQL text. The separate source-text
representation plan must address values PostgreSQL text cannot store, including
embedded NUL, before migrating them. The writer refuses those inputs atomically;
it does not delete or normalize characters to make an insert succeed.
