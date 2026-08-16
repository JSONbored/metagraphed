// A Substrate node's JSON-RPC response envelope (#11194).
//
// LIVES HERE for the reason r2-sql-envelope.ts states: a schema outside
// schemas-src is outside `no-passthrough`, `schema-shape-duplicates` and
// `schema-opacity`, which is exactly where an unreasoned open object survives.
// The first cut of this put it in `src/` beside its client and would have
// escaped all three.
import { z } from "zod";

/**
 * The JSON-RPC 2.0 envelope, PARSED rather than asserted.
 *
 * Every caller used to CAST this. `interface RpcResponse { result?: unknown;
 * error?: { message?: string } }` was declared twice byte-identically, in
 * head-poller.ts and raw-chain-capture.ts, with three more inline casts of the
 * same shape elsewhere -- a shape this repo declared about somebody else's API
 * and then never checked.
 *
 * A cast is not a check, and this is the most untrusted input the repo takes:
 * a public archive nobody here operates, over a protocol where the result and
 * the error share one envelope. A proxy answering 200 with an HTML error page
 * satisfies the cast and reaches the caller as `undefined` fields.
 *
 * A PLAIN object, the same call r2-sql-envelope.ts makes. Zod strips unknown
 * keys by default, so a node returning `jsonrpc` and `id` is accepted and those
 * members are simply not carried forward -- the protocol working, not a fault
 * here. `.passthrough()` was the first cut and `no-passthrough` rejected it,
 * correctly: nothing reads those fields, so declaring the object open would
 * have been openness without a reason.
 *
 * What it pins is that an OBJECT arrived carrying at most these two members, so
 * a body that cannot answer them is a classified failure rather than a silent
 * `undefined`.
 *
 * `error` is `unknown` rather than `{ message?: string }` because it is
 * implementation-defined -- safe-mode-watchdog was already stringifying the
 * whole thing precisely because the `.message` shape cannot be relied on.
 */
export const ChainRpcEnvelopeSchema = z.object({
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

/**
 * One member of a JSON-RPC 2.0 BATCH response.
 *
 * The same envelope plus the one member the single-call form deliberately
 * drops. Over one-request-per-response HTTP nothing correlates on `id`, which
 * is why the schema above strips it -- but a batch response is explicitly
 * PERMITTED TO BE REORDERED by the spec ("the Response objects being returned
 * ... MAY be returned in any order"), so `id` stops being decoration and
 * becomes the only thing tying an answer to the call that asked it. Reading a
 * batch positionally is the bug this member exists to make impossible.
 *
 * EXTENDED rather than redeclared: the result/error pair is one shape with one
 * owner, and a second literal copy of it here is what schema-shape-duplicates
 * exists to catch.
 *
 * `id` is narrowed to a number because every batch this repo sends numbers its
 * own calls (see chainRpcBatch). The spec allows string and null ids; accepting
 * them here would mean accepting an id that cannot index the request array, so
 * a node answering with one is a parse failure rather than a silent mismatch.
 */
export const ChainRpcBatchEntrySchema = ChainRpcEnvelopeSchema.extend({
  id: z.number(),
});

/**
 * A whole batch response: an array of envelopes.
 *
 * An ARRAY at the top level is the batch contract. A node that answers a batch
 * with a single object is either erroring on the whole request or does not
 * support batching, and both must be a classified failure here rather than an
 * array-shaped read of a non-array -- which is how a caller ends up looping
 * zero times and reporting success for a chunk it never captured.
 */
export const ChainRpcBatchSchema = z.array(ChainRpcBatchEntrySchema);
