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
