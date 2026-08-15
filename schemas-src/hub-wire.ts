// The internal Durable Object hubs' wire and storage schemas (#11194).
//
// LIVES HERE, not beside each hub, for the reason head-poller-wire.ts states:
// this repo keeps schemas in one source, and a declared vocabulary outside
// schemas-src is outside every gate that keeps schemas honest.
//
// ONE MODULE FOR THREE HUBS, because they speak ONE vocabulary. McpSessionHub,
// ChainFirehoseHub and SubnetStatusHub all exchange `{ sessionId }`,
// `{ sessionId, uri }` and `{ sessionId, netuid }` bodies over `fetch()`, and
// each had declared its own shape inline -- five restatements of "a session id
// is a non-empty string", which is five places for the rule to drift and no
// place that owns it.
//
// WHY A DURABLE OBJECT NEEDS SCHEMAS AT ALL. These bodies arrive over `fetch()`
// from another Worker, and the storage values come back from a PREVIOUS
// deploy's `persist()`. Both were read with `as`, which means:
//
//   * a body missing `sessionId` assigned `undefined` straight onto session
//     state, and the session then answered to nothing;
//   * ChainFirehoseHub's `/mcp-subscribe` added that `undefined` to its
//     subscriber Set, where `idFromName(undefined)` throws on EVERY subsequent
//     block -- inside the loop's own `catch`, so the poisoned entry costs a
//     swallowed throw per broadcast, forever, and nothing removes it;
//   * `subscribedUris` stored as a string would have been handed to
//     `new Set(...)`, which iterates a string BY CHARACTER -- a set of
//     single-letter "uris" that silently matches nothing.
//
// None of the three throws. All three produce a session that looks alive and
// delivers no notifications, which is the failure mode this whole family of
// work exists to remove.
//
// Types are inferred (`z.infer`) rather than written beside the schemas: a
// hand-written interface next to a validator is two things to keep in step, and
// the one that drifts is always the validator.
import { z } from "zod";
import { netuidSchema } from "./query-params.ts";

/** A session id as the hubs accept it: present and non-empty. */
const SessionIdSchema = z.string().min(1);

/** `POST /register` and `DELETE` — the body carrying only a session id.
 *
 * `sessionId` is nullable on the terminate path, which passes null to mean
 * "whatever session this object holds". Kept as one schema with the null
 * allowed rather than two, because the handler's own check
 * (`sessionId && sessionId !== this.sessionId`) already treats null as
 * "unspecified" and splitting them would restate that rule in a second place.
 */
export const HubSessionIdBodySchema = z.object({
  sessionId: SessionIdSchema.nullable(),
});
export type HubSessionIdBody = z.infer<typeof HubSessionIdBodySchema>;

/**
 * The same body where null is NOT a valid answer.
 *
 * ChainFirehoseHub's `/mcp-subscribe` keys a Set by this value and
 * SubnetStatusHub indexes by it; neither has a "the session I already hold"
 * fallback to fall back to, so an absent id is a malformed call rather than an
 * unspecified one. Derived from the nullable schema above rather than restated,
 * so "a session id is a non-empty string" stays declared once.
 */
export const HubRequiredSessionIdBodySchema = HubSessionIdBodySchema.extend({
  sessionId: SessionIdSchema,
});
export type HubRequiredSessionIdBody = z.infer<
  typeof HubRequiredSessionIdBodySchema
>;

/** `POST /subscribe` and `/unsubscribe` on McpSessionHub. */
export const HubSessionUriBodySchema = z.object({
  sessionId: SessionIdSchema,
  uri: z.string().min(1),
});
export type HubSessionUriBody = z.infer<typeof HubSessionUriBodySchema>;

/** `POST /notify` — a resource changed; the hub coalesces and replays it. */
export const HubNotifyBodySchema = z.object({
  uri: z.string().min(1),
});
export type HubNotifyBody = z.infer<typeof HubNotifyBodySchema>;

/**
 * SubnetStatusHub's `/mcp-subscribe` and `/mcp-unsubscribe`.
 *
 * `netuid` accepts the RESOURCE URI as well as the number, because
 * `handleSubscribe` has always resolved `metagraph://subnet/{netuid}/status`
 * here and dropping that would narrow a live contract. The union is declared,
 * not inferred from a cast: the string arm is a documented alternate spelling,
 * and anything outside both arms is refused rather than silently parsed to
 * NaN. The netuid arm reuses the registry's own bound (`netuidSchema`) instead
 * of restating `int >= 0`, so the range this hub accepts cannot drift from the
 * range every other surface accepts.
 */
export const HubNetuidSchema = netuidSchema();

export const HubSubnetSessionBodySchema = z.object({
  sessionId: SessionIdSchema,
  netuid: z.union([HubNetuidSchema, z.string().min(1)]),
});
export type HubSubnetSessionBody = z.infer<typeof HubSubnetSessionBodySchema>;

/**
 * SubnetStatusHub's `/notify-changed`, from the health prober.
 *
 * The array is REQUIRED but its elements are only bounded, not filtered here:
 * the handler de-duplicates and drops out-of-range entries, and a prober that
 * sends one bad netuid among fifty should still deliver the other forty-nine.
 * Refusing the whole call would turn a partial producer fault into a total
 * delivery outage.
 */
export const HubNotifyChangedBodySchema = z.object({
  netuids: z.array(z.unknown()),
});
export type HubNotifyChangedBody = z.infer<typeof HubNotifyChangedBodySchema>;

/**
 * A browser PushSubscription's server-relevant fields.
 *
 * WAS A HAND-WRITTEN INTERFACE in src/web-push.ts, which is the shape this
 * repo keeps finding drifted: an `interface` beside the code that validates it
 * describes what someone believed, and only the validator describes what is
 * enforced. `PushSubscriptionKeys` is now inferred from this, so there is one
 * statement of it.
 *
 * `min(1)` on all three because every consumer already required them non-empty
 * -- AlerterHub's `!sub?.endpoint || !sub.p256dh || !sub.auth`, data-api's
 * `if (!p256dh || !authKey)`. The rule was stated twice and declared nowhere.
 *
 * The base64url SHAPE of the key material is deliberately NOT checked here.
 * data-api validates it at intake (`isValidPushKeyMaterial`) with its own
 * error message, which is where a malformed subscription should be refused;
 * re-deriving that rule here would be a second owner for it.
 */
export const PushSubscriptionKeysSchema = z.object({
  /** The push service URL the browser handed us. Origin identifies the service. */
  endpoint: z.string().min(1),
  /** UA public key, P-256 uncompressed point (65 bytes), base64url. */
  p256dh: z.string().min(1),
  /** UA auth secret (16 bytes), base64url. */
  auth: z.string().min(1),
});
export type PushSubscriptionKeys = z.infer<typeof PushSubscriptionKeysSchema>;

/**
 * `GET /api/v1/internal/push-subscription` as AlerterHub reads it.
 *
 * `subscription` is nullish because ABSENCE IS AN ANSWER: the producer returns
 * `{ subscription: null }` for an endpoint it has no row for, which means the
 * browser unsubscribed -- not that the read failed.
 */
export const AlerterPushSubscriptionResponseSchema = z.object({
  subscription: PushSubscriptionKeysSchema.nullish(),
});

/**
 * `GET /api/v1/internal/alert-triggers-dereg-risk-snapshot` as AlerterHub
 * reads it.
 *
 * Every field OPTIONAL and NULLABLE, matching `buildDeregRiskSnapshot`'s own
 * signature: a snapshot missing one of the three is a partial answer the
 * builder already handles, not a malformed one.
 *
 * WHAT THIS DOES AND DOES NOT FIX. The three casts it replaces
 * (`as Array<Record<string, unknown>>` twice, `as number` once) checked
 * nothing, but `buildDeregRiskSnapshot` re-validates everything it is handed
 * -- `Number.isFinite(currentBlock)` and a per-row `Number.isInteger` gate --
 * so a wrong-typed field already produced an EMPTY snapshot rather than a
 * wrong one. This is not a latent crash being fixed.
 *
 * It is the DIFFERENCE BETWEEN THE TWO EMPTIES that matters. "The producer
 * sent nothing" and "the producer sent something this hub could not read" both
 * ended as an empty snapshot and neither said so, on the one code path whose
 * whole job is deciding when a user's alert fires. Parsing separates them, and
 * the caller now reports the second.
 *
 * Rows stay `Record<string, unknown>`: the builder's own field readers narrow
 * each column they touch, and declaring a column list here would be a second
 * owner for a vocabulary src/dereg-risk.ts already holds.
 */
export const AlerterDeregRiskSnapshotResponseSchema = z.object({
  subnets: z.array(z.record(z.string(), z.unknown())).nullish(),
  immune_neurons: z.array(z.record(z.string(), z.unknown())).nullish(),
  current_block: z.number().nullish(),
});

/**
 * What McpSessionHub's `persist()` writes and `hydrate()` reads back.
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
 * by nobody and hydrated by nobody.
 *
 * One owner now. Adding a field to the schema makes both sides carry it.
 */
export const MCP_SESSION_STATE_KEYS = Object.keys(
  McpSessionStateSchema.shape,
) as Array<keyof McpSessionState>;
