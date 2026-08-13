/**
 * "Durable Object reset because its code was updated." (#11021)
 *
 * Cloudflare evicts a Durable Object when its script version changes, and this
 * repo deploys often -- a 3-day production window carried ~29 distinct
 * `script_version.id` values, roughly ten a day. Every one of those resets
 * every DO, and once reset, EVERY pending operation on that instance rejects
 * with this message: the storage write in flight, the `setAlarm` in a
 * `finally`, the `stub.fetch` a subscriber is holding.
 *
 * That is a lifecycle event, not a fault. Left unhandled it becomes an
 * `outcome: exception` -- and, on the public SSE route, an HTTP 500 to a
 * subscriber, which is the one response that says WE are broken.
 *
 * MATCHED BY MESSAGE, deliberately and narrowly. The runtime raises a plain
 * `Error` with no code or type to key off, so a message match is the only
 * available discriminator. It is kept exact rather than fuzzy (no "reset"
 * substring, no case-folding beyond what the runtime emits) precisely because
 * the risk of this helper is over-matching: a broad predicate here would
 * silently swallow real DO failures, and a dead hub that looks healthy is the
 * failure mode #10991's alarm work exists to prevent.
 */
const DURABLE_OBJECT_RESET_MESSAGE =
  "Durable Object reset because its code was updated.";

/** True only for the runtime's DO-eviction rejection, never for anything else. */
export function isDurableObjectReset(error: unknown): boolean {
  return (
    error instanceof Error && error.message === DURABLE_OBJECT_RESET_MESSAGE
  );
}

/**
 * How long a disconnected subscriber should wait before reconnecting, in ms.
 *
 * Sent as the SSE `retry:` field, which is the ONLY reconnection control the
 * protocol gives a server -- `Retry-After` is not honoured by `EventSource`,
 * and a non-2xx status makes the spec "fail the connection" permanently rather
 * than reconnect. So a deploy must answer 200 with a stream that closes, and
 * this number is what stops every subscriber returning in the same instant.
 *
 * 5s: comfortably past a deploy's propagation, and long enough that a
 * simultaneous fleet reconnect is spread rather than a thundering herd -- the
 * failure #6451 already produced once on this exact hub.
 */
export const CHAIN_FIREHOSE_RECONNECT_MS = 5000;
