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

/** `POST /subscribe` and `/unsubscribe` on McpSessionHub. */
export const HubSessionUriBodySchema = z.object({
  sessionId: SessionIdSchema,
  uri: z.string().min(1),
});

/** `POST /notify` — a resource changed; the hub coalesces and replays it. */
export const HubNotifyBodySchema = z.object({
  uri: z.string().min(1),
});

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
const PushSubscriptionKeysSchema = z.object({
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
 * A cold-tier chain-events answer, as it comes BACK OUT of the edge cache.
 *
 * The tier travels with the payload so `meta.source` reports which store
 * answered rather than guessing. That makes `source` the one field a cache hit
 * must carry: a hit missing it would report a tier it never came from, which is
 * precisely the mislabelling ColdTierAnswer was introduced to stop.
 *
 * A cached entry was written by a PREVIOUS deploy, so this is the boundary it
 * looks least like: same Worker, same code, different version of it.
 */
export const ColdTierAnswerSchema = z.object({
  data: z.record(z.string(), z.unknown()),
  source: z.string(),
});

/**
 * `GET /api/v1/rpc/pools` as the wss load balancer reads it.
 *
 * DELIBERATELY LOOSE ALL THE WAY DOWN, and this is not laziness: every field
 * the selector touches (`url`, `score`, `pool_eligible`, `latest_block`) is
 * re-read through its own coercion there -- `Number(e.score)`, an explicit
 * null check on `latest_block` because `Number(null)` is 0 and would mis-read a
 * block-less endpoint as height 0. Typing them here would state a second,
 * stricter contract that the selector then ignores.
 *
 * What IS pinned is the structure the selector navigates: `pools` is a list --
 * REQUIRED, which is the whole point. Optional here would let `{ error: "not
 * found" }` parse as an artifact with no pools, which is precisely the reading
 * the cast produced and precisely what a caller cannot tell from "no upstream
 * is eligible right now". One of those is an outage; the other is Tuesday.
 * An EMPTY list still parses, because that genuinely is the second case.
 */
const WssPoolEndpointSchema = z.object({
  id: z.string().optional(),
  url: z.unknown().optional(),
  kind: z.string().optional(),
  pool_eligible: z.unknown().optional(),
  score: z.unknown().optional(),
  status: z.string().optional(),
  latest_block: z.unknown().optional(),
});
export type WssPoolEndpoint = z.infer<typeof WssPoolEndpointSchema>;

const WssPoolSchema = z.object({
  id: z.string().optional(),
  kind: z.string().optional(),
  endpoints: z.array(WssPoolEndpointSchema).optional(),
});
export type WssPool = z.infer<typeof WssPoolSchema>;

const WssPoolsArtifactSchema = z.object({
  pools: z.array(WssPoolSchema),
});
export type WssPoolsArtifact = z.infer<typeof WssPoolsArtifactSchema>;

/**
 * The same artifact as `/api/v1` serves it: wrapped in an envelope.
 *
 * Both spellings are accepted because the artifact is served enveloped on
 * `/api/v1` and bare as a file, and this reader must keep working if the route
 * moves -- the tolerance the cast expressed as an intersection type, which is
 * not a thing a runtime value can be.
 */
export const WssPoolsResponseSchema = z.union([
  z.object({ data: WssPoolsArtifactSchema }),
  WssPoolsArtifactSchema,
]);

/**
 * One active alert trigger, as AlerterHub caches it.
 *
 * `id` and `channel` are the two fields the hub itself uses -- `id` keys the
 * rate-limit map and the write-back, `channel` picks the delivery builder --
 * and everything else rides through to `triggerMatchesEvent` and the builders,
 * which narrow what they read. So this pins exactly the hub's own dependency
 * and passes the rest along: `catchall(unknown)` because a trigger genuinely
 * carries per-channel fields this file must not enumerate (a second copy of a
 * vocabulary src/alert-triggers.ts owns), and stripping them would DELETE the
 * destination every delivery needs.
 */
export const AlertTriggerRowSchema = z
  .object({
    id: z.string(),
    channel: z.string(),
    condition: z.unknown().optional(),
    // The evaluator's own fields (#11339). The producer already emits these --
    // `evaluatorAlertTriggerView` builds every row of this response, in exactly
    // this camelCase -- but the schema stopped at `id`/`channel`, so the hub
    // parsed a row and then wrote `trigger as unknown as EvaluatorAlertTrigger`
    // to use it. The comment there said the shape "is already right at runtime",
    // which is true and is precisely what a schema is for stating.
    //
    // Nullish rather than required: `.flatMap` below drops a row that fails to
    // parse, and a trigger missing an optional filter is a valid trigger, not a
    // malformed one. Dropping it would silence a live alert.
    name: z.unknown().optional(),
    tableFilter: z.array(z.string()).nullish(),
    netuid: z.number().nullish(),
    eventKind: z.string().nullish(),
    account: z.string().nullish(),
    minAmountTao: z.number().nullish(),
    destination: z.unknown().optional(),
  })
  .catchall(z.unknown());

/**
 * `GET /api/v1/internal/alert-triggers-active`.
 *
 * Per-ROW parsing happens at the call site for the reason the rest of this
 * family follows: one malformed trigger among fifty must not silence the other
 * forty-nine, and refusing the page would leave the hub evaluating a stale
 * cache while reporting nothing.
 */
export const AlertTriggersActiveResponseSchema = z.object({
  triggers: z.array(z.unknown()),
});

/**
 * `GET /api/v1/internal/keys/anomalies` as the abuse-scan cron reads it.
 *
 * Only `flagged_count` decides anything (it is compared against a threshold);
 * `accounts_seen` rides along in the alert text. Both nullish, because a
 * deployment with no anomaly detector configured answers without them and that
 * is a legitimate zero rather than a fault.
 */
export const AbuseScanAnomaliesResponseSchema = z.object({
  flagged_count: z.number().nullish(),
  accounts_seen: z.number().nullish(),
});

/**
 * The embedding manifest in KV: document id → content hash.
 *
 * WRITTEN BY A PREVIOUS DEPLOY, which is the whole reason this is parsed. The
 * manifest decides which documents are re-embedded and which stale vectors are
 * pruned; a value of the wrong type here is compared against a fresh hash,
 * never matches, and silently re-embeds the entire corpus on every run -- a
 * cost, not a crash, and therefore one nothing would have reported.
 */
export const EmbedManifestSchema = z.record(z.string(), z.string());

/**
 * The resync lane's KV pass state.
 *
 * The reader's own four-clause guard (`head` a non-empty string, `paths` a
 * non-empty array, `offset` a non-negative integer) is what this declares.
 * Stating it here rather than there means the state's shape and the state's
 * validity are one thing: a malformed state is discarded and the next tick
 * starts a clean pass, which was already the recovery.
 */
export const RegistryResyncPassStateSchema = z.object({
  head: z.string().min(1),
  paths: z.array(z.string()).min(1),
  offset: z.int().min(0),
});
export type RegistryResyncPassState = z.infer<
  typeof RegistryResyncPassStateSchema
>;

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

/**
 * `POST /api/v1/internal/quota/spend` as the rate limiter reads it.
 *
 * The limiter used to check ONE field by hand -- `typeof payload?.allowed !==
 * "boolean"` -- and then return the whole body as a fully-shaped quota via
 * `as never`, so `used`/`limit`/`remaining`/`resetAt` were never established
 * and every consumer read them off a shape nothing had checked (#11339).
 *
 * STRICT on the four numbers and the stamp, because the caller publishes them
 * in a response header and a partial quota reads as a real one. A body that
 * does not parse is treated exactly as the hand-rolled check treated a missing
 * `allowed`: fail OPEN, because a quota-store hiccup must not become a 429
 * from a store that never said no.
 */
export const QuotaSpendResponseSchema = z
  .object({
    allowed: z.boolean(),
    used: z.number(),
    limit: z.number(),
    remaining: z.number(),
    resetAt: z.string(),
  })
  .catchall(z.unknown());
export type QuotaSpendResponse = z.infer<typeof QuotaSpendResponseSchema>;
