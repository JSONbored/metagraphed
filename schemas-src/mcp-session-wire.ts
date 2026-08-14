// The MCP session hub's wire and storage schemas (#11194).
//
// LIVES HERE, not in workers/mcp-session-hub.ts, for the reason
// head-poller-wire.ts states: this repo keeps schemas in one source, and a
// declared vocabulary outside schemas-src is outside every gate that keeps
// schemas honest.
//
// WHY A DURABLE OBJECT NEEDS THEM AT ALL. The bodies below arrive over
// `fetch()` from the Worker, and the storage values below come back from a
// PREVIOUS deploy's `persist()`. Both were read with `as`, which means:
//
//   * a body missing `sessionId` assigned `undefined` straight onto session
//     state, and the session then answered to nothing;
//   * `subscribedUris` stored as a string would have been handed to
//     `new Set(...)`, which iterates a string BY CHARACTER -- a set of
//     single-letter "uris" that silently matches nothing.
//
// Neither throws. Both produce a session that looks alive and delivers no
// notifications, which is the failure mode this whole family of work exists to
// remove.
//
// Types are inferred (`z.infer`) rather than written beside the schemas: a
// hand-written interface next to a validator is two things to keep in step, and
// the one that drifts is always the validator.
import { z } from "zod";

/** A session id as the hub accepts it: present and non-empty. */
const SessionIdSchema = z.string().min(1);

/** `POST /register` and `DELETE` — the body carrying only a session id.
 *
 * `sessionId` is nullable on the terminate path, which passes null to mean
 * "whatever session this object holds". Kept as one schema with the null
 * allowed rather than two, because the handler's own check
 * (`sessionId && sessionId !== this.sessionId`) already treats null as
 * "unspecified" and splitting them would restate that rule in a second place.
 */
export const McpSessionIdBodySchema = z.object({
  sessionId: SessionIdSchema.nullable(),
});
export type McpSessionIdBody = z.infer<typeof McpSessionIdBodySchema>;

/** `POST /subscribe` and `/unsubscribe`. */
export const McpSessionUriBodySchema = z.object({
  sessionId: SessionIdSchema,
  uri: z.string().min(1),
});
export type McpSessionUriBody = z.infer<typeof McpSessionUriBodySchema>;

/** `POST /notify` — a resource changed; the hub coalesces and replays it. */
export const McpNotifyBodySchema = z.object({
  uri: z.string().min(1),
});
export type McpNotifyBody = z.infer<typeof McpNotifyBodySchema>;

/**
 * What `persist()` writes and `hydrate()` reads back.
 *
 * EVERY FIELD OPTIONAL, and that is not laxness: a durable object hydrating for
 * the first time has none of them, and `pendingUris` in particular was never
 * persisted at all until recently -- so an object written by an older deploy
 * legitimately lacks it. The reader defaults each one; this schema's job is to
 * reject a value of the WRONG TYPE, not to demand a complete record.
 */
export const McpSessionStateSchema = z.object({
  sessionId: SessionIdSchema.nullish(),
  subscribedUris: z.array(z.string()).nullish(),
  pendingUris: z.array(z.string()).nullish(),
  sequence: z.int().min(0).nullish(),
  terminated: z.boolean().nullish(),
});
export type McpSessionState = z.infer<typeof McpSessionStateSchema>;

/**
 * The storage keys, DERIVED from the schema rather than restated.
 *
 * `hydrate()` used to pass a hand-written array to `storage.get([...])` while
 * `persist()` wrote its own object literal and this schema listed the fields a
 * third time -- three places to keep in step, and the failure is silent in the
 * direction that matters: add a field to `persist()` alone and `hydrate()`
 * never reads it back, which is exactly how `pendingUris` came to be persisted
 * by nobody and hydrated by nobody until #? found it.
 *
 * One owner now. Adding a field to the schema makes both sides carry it.
 */
export const MCP_SESSION_STATE_KEYS = Object.keys(
  McpSessionStateSchema.shape,
) as Array<keyof McpSessionState>;
