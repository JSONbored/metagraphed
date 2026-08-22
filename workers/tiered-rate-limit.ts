// Shared tiered rate-limit helper (#8386), generalized from
// workers/request-handlers/fullnode-rpc-proxy.ts's own
// FULLNODE_RPC_TIER_RATE_LIMITS pattern (ADR 0021) so a general public-API
// route can opt into "anonymous vs. self-serve keyed" tiering without
// re-deriving that pattern per route.
//
// A caller with a valid `mg_...` API key (src/api-key-validation.ts) gets the
// route's `keyed` policy, keyed by accountId (stable per account, so many
// callers legitimately sharing one key aren't starved, and rotating source
// IPs can't inflate one key's effective ceiling). Everyone else gets the
// route's unchanged `anonymous` policy, keyed by client IP -- the existing,
// regression-tested posture every route already has today.
//
// Deliberately still a Cloudflare-native Rate Limiting binding per tier (not
// Unkey's own per-key ratelimits) -- same reasoning as the fullnode gate's
// own header comment: this repo's rate limiting stays on infrastructure this
// codebase can introspect/test directly, not a third party's opaque counter.
import { resolveClientIp } from "./config.ts";
import {
  API_KEY_LOOKUP_TOKEN_HEADER,
  validateApiKey,
} from "../src/api-key-validation.ts";
import { routeCost } from "../src/route-cost-weights.ts";
import { evaluateBlock, type BlockVerdict } from "../src/api-key-abuse.ts";
import { DEFAULT_ACCOUNT_KIND, type AccountKind } from "../src/account-kind.ts";
import { recordOrNull } from "../src/read-store.ts";
import { registerModuleStateReset } from "../src/module-state-registry.ts";
import { QuotaSpendResponseSchema } from "../schemas-src/internal-wire.ts";

/**
 * The rate-limiter binding a policy NAMES, or undefined.
 *
 * A real lookup, not a property access: the policy config carries its binding
 * as a string (`policy.envVar`), and `Env` is an interface, which TypeScript
 * never gives an implicit index signature -- so all three call sites wrote
 * `env as unknown as Record<string, RateLimit | undefined>` to index it
 * (#11339).
 *
 * Narrows on `.limit` rather than on mere presence, which the cast could not
 * do at all: an unbound name reads as `undefined`, but a WRONG name reads as
 * whatever else is bound under it. A KV namespace passes `!== undefined` and
 * then throws inside `.limit()` -- on the request path, mid-flight, as a 500
 * rather than as the open-fail the callers below intend.
 */
export function rateLimiterBinding(
  env: unknown,
  name: string,
): RateLimit | undefined {
  const binding = recordOrNull(env)?.[name];
  return typeof (binding as RateLimit | undefined)?.limit === "function"
    ? (binding as RateLimit)
    : undefined;
}

export interface RateLimitTierPolicy {
  /** Env binding name for this tier's Cloudflare Rate Limiting binding. */
  envVar: string;
  limit: number;
  windowSeconds: number;
  /**
   * Daily ceiling in COST units, not requests (#8608). Omit for no daily cap.
   *
   * Cost units come from src/route-cost-weights.ts, which follows ADR 0022's
   * four cost shapes -- a cached artifact read spends 1, a deep-history scan
   * 5, a bulk archive pull 10, an LLM call 25. Counting requests instead would
   * price them all identically, which ADR 0022 names as the central flaw in a
   * flat-multiplier model.
   *
   * Enforced against `api_quota_daily` on our own indexer box (src/daily-
   * quota.ts, workers/data-api.ts's handleApiQuotaSpend), consulted ONLY when
   * this field is set, so the extra round trip lands on precisely the callers
   * the quota is for -- never on anonymous or unlimited traffic.
   */
  dailyUnits?: number;
}

export interface TieredRateLimitConfig {
  anonymous: RateLimitTierPolicy;
  /**
   * Fallback for a valid key whose tier has no entry in `tiers` -- an account
   * on a tier this route has not priced yet, or a tier string we do not
   * recognise. Deliberately a fallback rather than an error: an unpriced tier
   * must never become an outage for a paying caller.
   */
  keyed: RateLimitTierPolicy;
  /**
   * Per-tier ceilings, keyed by `rpc_accounts.tier` (#8608). Before this, every
   * valid key got the single `keyed` policy no matter what tier it was on --
   * `validateApiKey` already resolved the tier and the result was thrown away,
   * so a paid account and a free one were rate-limited identically and #6646
   * had nothing to attach a paid model to.
   *
   * The tier is read from the key lookup on every request, so a server-side
   * tier change takes effect WITHOUT re-issuing the key -- bounded by the
   * lookup's KV cache (API_KEY_LOOKUP_KV_TTL, 30 min), not by the key's
   * lifetime.
   */
  tiers?: Record<string, RateLimitTierPolicy>;
  /** Short label used in the rate-limit key, e.g. "data" -- keeps different
   * routes' limiter keys from colliding if they ever share a binding. */
  keyPrefix: string;
}

export interface TieredRateLimitResult {
  allowed: boolean;
  policy: RateLimitTierPolicy;
  /** The tier the policy was chosen for: a tier name, or "anonymous". */
  tier: string;
  /**
   * The daily-quota verdict, when this tier defines one and the store answered.
   * Carries its own `allowed` because that -- not a derived comparison -- is
   * what tells the 429 which ceiling actually rejected the caller. A caller
   * with 10 units left who makes a 25-unit call is rejected BY THE QUOTA while
   * `remaining` is still 10, so inferring the scope from `remaining <= 0`
   * mislabels exactly the case a cost-weighted quota exists to create.
   */
  quota?: {
    allowed: boolean;
    used: number;
    limit: number;
    remaining: number;
    resetAt: string;
  };
  /**
   * Set instead of `quota` when the caller asked to DEFER the spend. The
   * per-minute limiter has already passed; this carries what the caller needs
   * to debit the cost-weighted quota once it knows what the request costs.
   * Only a multiplexed transport needs this -- see the `deferQuota` option.
   */
  quotaPending?: {
    accountId: string;
    accountKind: AccountKind;
    dailyUnits: number;
  };
  /** The verified account id when a valid API key was supplied, else null
   * (anonymous, IP-keyed). */
  accountId: string | null;
  /**
   * WHICH identity system `accountId` belongs to (#11573).
   *
   * Always set, even when `accountId` is null, so a consumer never has to
   * infer it. `rpc_accounts` and `github_accounts` are separate sequences in
   * the same numeric range, so an id without a kind is not an identity -- see
   * src/account-kind.ts.
   */
  accountKind: AccountKind;
  /**
   * Set when the account is on the #8611 blocklist. Present ONLY on a rejection
   * -- an allowed request carries no block, so a caller cannot tell from a 200
   * that a blocklist exists at all.
   */
  block?: BlockVerdict;
}

/**
 * TTL for the cached blocklist snapshot (#8611).
 *
 * 60s is the "effective at the edge within one cache interval" the issue asks
 * for, made small enough to actually mean something. The snapshot is one tiny
 * KV value covering every blocked account -- not one entry per key -- so a
 * short TTL costs one cheap edge-local read per request, not a fan-out.
 */
export const BLOCKLIST_KV_TTL = 60;
export const BLOCKLIST_KV_KEY = "api-key-blocklist";

/**
 * The block verdict for this account, from the cached snapshot.
 *
 * Fails OPEN on every error path, and unlike the rate-limit gate the reason is
 * asymmetry of harm rather than politeness to paying callers: a corrupt or
 * unreachable blocklist that read as "blocked" would lock out EVERY customer
 * at once, while reading as "not blocked" costs one TTL of traffic from an
 * already-identified bad actor.
 */
async function loadBlockVerdict(
  env: Env,
  accountId: unknown,
  accountKind: AccountKind,
): Promise<BlockVerdict> {
  const kv = env.METAGRAPH_CONTROL;
  if (!kv?.get) return evaluateBlock(null, accountId, accountKind);
  try {
    const snapshot = (await kv.get(BLOCKLIST_KV_KEY, { type: "json" })) as {
      blocks?: unknown;
    } | null;
    return evaluateBlock(snapshot, accountId, accountKind);
  } catch {
    return evaluateBlock(null, accountId, accountKind);
  }
}

/**
 * Spend this request's cost against the account's daily quota.
 *
 * The counter lives in `api_quota_daily` on our own indexer box, reached over
 * the DATA_API service binding -- the same authenticated internal path
 * workers/api.ts's recordApiKeyUsage already uses on every keyed request, so
 * this adds a round trip on a proven connection rather than a new dependency.
 * The retired Postgres schema recorded why that beat a Durable
 * Object and Redis.
 *
 * Returns null when the binding or shared secret is absent, and on any
 * non-200 or thrown error -- fails OPEN, matching every other rate-limit
 * checkpoint in this codebase: an unprovisioned deploy prerequisite, or a
 * database having a moment, must never block a paying caller. The per-minute
 * limiter still applies in every one of those cases.
 */
async function spendDailyQuota(
  request: Request,
  env: Env,
  accountId: string,
  accountKind: AccountKind,
  dailyUnits: number,
  /** Explicit cost, when the pathname cannot price the work. See below. */
  costUnitsOverride?: number,
  // NULLABLE, which it always was. This said non-null and then returned `null`
  // on four paths -- no binding, a non-ok response, an unparseable body, and a
  // throw -- with `as never` making each one assignable. So every caller was
  // typed as holding a quota it might not have, and the compiler could not
  // point at the reads that assume otherwise (#11339).
): Promise<(TieredRateLimitResult["quota"] & { allowed: boolean }) | null> {
  const dataApi = env.DATA_API;
  const token = env.API_KEY_LOOKUP_INTERNAL_TOKEN;
  if (!dataApi?.fetch || !token) return null;
  // The pathname prices the work for REST, where one path IS one operation.
  // It cannot for a multiplexed transport: every MCP call is POST /mcp, which
  // falls to the `edge` catch-all, so an LLM generation and an artifact read
  // billed the same 1 unit. Such callers pass their own cost (see
  // src/mcp-tool-cost.ts) and it wins over the pathname.
  const { weight } =
    typeof costUnitsOverride === "number" && Number.isFinite(costUnitsOverride)
      ? { weight: Math.max(1, Math.trunc(costUnitsOverride)) }
      : routeCost(new URL(request.url).pathname);
  try {
    const response = await dataApi.fetch(
      new Request("https://api.metagraph.sh/api/v1/internal/keys/quota", {
        method: "POST",
        headers: {
          [API_KEY_LOOKUP_TOKEN_HEADER]: token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          account_id: Number(accountId),
          // #11573: the quota row is keyed on (kind, id). Without this an
          // OAuth caller would debit the rpc account of the same number.
          account_kind: accountKind,
          cost: weight,
          limit: dailyUnits,
        }),
      }),
    );
    if (!response.ok) return null;
    // PARSED, not spot-checked. The old check read ONE field by hand and then
    // returned the whole body as a fully-shaped quota, so `used`/`limit`/
    // `remaining`/`resetAt` reached the response header unverified.
    //
    // The reasoning for failing open is unchanged and still load-bearing: ANY
    // 200 whose body lacks `allowed` -- a shape change on the data-api side, a
    // proxy interposing its own JSON, a route that silently stops existing --
    // would read as `!undefined`, i.e. REJECTED, and every quota'd caller would
    // start getting 429s from a store that never said no.
    const parsed = QuotaSpendResponseSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    // Same posture as a missing binding: never turn a quota-store hiccup into
    // an outage for a caller who is paying us.
    return null;
  }
}

/**
 * Resolves which tier applies (valid `mg_...` key -> keyed, else anonymous)
 * and checks that tier's Cloudflare Rate Limiting binding. Never throws on
 * attacker-controlled input -- an invalid/malformed key silently falls back
 * to the anonymous tier rather than rejecting the request outright (a bad
 * key is not itself abuse; the anonymous ceiling still applies to it).
 */
/**
 * A settled x402 payment, attached to the request it paid for (infra#629).
 *
 * A WeakMap keyed by Request, mirroring workers/api.ts's own
 * requestAuthTier/requestAccountId markers -- the payment is verified at the
 * router, but the limiter that must honour it runs several frames deeper
 * inside each handler, and threading an option through every one of them would
 * mean every future handler remembering to.
 *
 * Weak on purpose: the entry dies with the request, so a settled payment can
 * never be replayed onto a later one.
 */
let paidCalls = new WeakMap<Request, { payer: string; tier: string }>();

// See src/module-state-registry.ts. A WeakMap cannot be cleared, so the reset
// replaces it -- which is the honest restoration to the post-load baseline, and
// the reason the binding above is `let`.
//
// Under `isolate: false` this module's registry is shared by every test file in
// a worker. The entries here are keyed by Request objects that die with the
// file that made them, so nothing observable leaks; registering anyway is the
// point of the gate, which asks each module to say what its baseline IS rather
// than to argue case by case that its particular state is harmless.
registerModuleStateReset("workers/tiered-rate-limit.ts", () => {
  paidCalls = new WeakMap();
});

/**
 * Record that this request's payment settled, and what it bought.
 *
 * An empty payer is dropped rather than bucketed: a facilitator that settles
 * without naming one leaves a payment that genuinely moved money and genuinely
 * cannot be attributed. Giving every such call the same key would put unrelated
 * payers in one shared budget, where the first to exhaust it throttles the
 * rest -- so the call proceeds on the anonymous bucket instead. This rule lives
 * here, with the bucket, and not at the call site.
 */
export function markPaidCall(
  request: Request,
  payer: string,
  tier: string,
): void {
  if (payer && tier) paidCalls.set(request, { payer, tier });
}

export async function applyTieredRateLimit(
  request: Request,
  env: Env,
  config: TieredRateLimitConfig,
  /**
   * What this request costs, when its pathname cannot say. Only the daily quota
   * uses it; the per-minute limiter counts requests, not units.
   */
  {
    costUnits,
    deferQuota,
    oauthIdentity,
    paidIdentity,
  }: {
    costUnits?: number;
    /**
     * An ALREADY-VERIFIED OAuth caller and the tier resolved for them
     * (#11562). Supplied by the surface that holds the OAuth context; this
     * module never validates a token itself.
     *
     * Ranked BELOW a valid `mg_` key on purpose: a caller who sends a key is
     * asserting that identity deliberately, which is the same precedence
     * `mcpDistinctId` applies when both are present.
     */
    oauthIdentity?: { accountId: number; tier: string } | null;
    /**
     * A SETTLED x402 payment (infra#629): the payer's address, which x402
     * treats as the agent's identity -- "the wallet replaces the API key".
     *
     * Ranked below both credential systems: a caller who also presents a key
     * or an OAuth token has asserted a durable identity, and that account's
     * tier is the one their traffic should be measured against.
     *
     * This is what a payment BUYS. Without it the payment would settle and
     * change nothing, which is worse than not taking it.
     */
    paidIdentity?: { payer: string; tier: string } | null;
    /**
     * Skip the daily-quota spend and hand back `quotaPending` instead.
     *
     * The per-minute limiter MUST stay ahead of body parsing -- a caller over
     * its ceiling should be refused without us doing work for it, which
     * tests/mcp-server.test.ts pins. But the cost-weighted quota cannot be
     * priced until the body says which tools are being called. Deferring lets
     * both hold: gate on count first, bill on cost second.
     */
    deferQuota?: boolean;
  } = {},
): Promise<TieredRateLimitResult> {
  // An explicitly-passed identity wins; otherwise honour a payment the router
  // already settled for this exact request.
  const settledPayment = paidIdentity ?? paidCalls.get(request) ?? null;
  const authHeader = request.headers.get("authorization");
  const auth = authHeader
    ? await validateApiKey(env, authHeader)
    : { ok: false as const };

  // #11573: ONE identity, from either system, so the blocklist, the per-minute
  // ceiling and the daily quota all apply to an OAuth caller exactly as they do
  // to a key holder. The alternative -- a second branch that took only the
  // ceiling -- would ship a tier that is two-thirds enforced, and would have to
  // be undone the moment billing attaches.
  //
  // A KEY OUTRANKS AN OAUTH TOKEN: a caller presenting a key is asserting that
  // identity deliberately, which is the precedence `mcpDistinctId` already
  // applies when both are present.
  const identity = auth.ok
    ? {
        // `String()` unconditionally turned a null account id into the LITERAL
        // "null" -- a single fabricated tenant that every identity-less key
        // shared. verifyUnkeyKey returns `accountId: identity?.externalId ??
        // null` while `valid` stays true, so any key minted without an Unkey
        // identity landed there. Downstream that string is an identity:
        // resolveSurfaceCredentialIdentity accepts it and returns
        // `account:null`, so one holder could list, delete, and use another's
        // stored surface credentials. It also collapsed them into one
        // rate-limit bucket and one quota row, and `Number("null")` is NaN.
        //
        // Every consumer of this field already guards with
        // `if (rateLimit.accountId)` and the declared type is `string | null`,
        // so a real null is what they were written for.
        accountId: auth.accountId == null ? null : String(auth.accountId),
        accountKind: DEFAULT_ACCOUNT_KIND,
        tier: typeof auth.tier === "string" && auth.tier ? auth.tier : null,
      }
    : oauthIdentity
      ? {
          accountId: String(oauthIdentity.accountId),
          accountKind: "github" as const,
          tier: oauthIdentity.tier,
        }
      : settledPayment
        ? {
            // NOT an account id: a payer address belongs to no account table,
            // so it stays out of `accountId` -- which every consumer reads as
            // an rpc_accounts id -- and is carried only in the limiter key
            // below. A settled payment buys headroom for this call; it does
            // not mint an account.
            accountId: null,
            accountKind: DEFAULT_ACCOUNT_KIND,
            tier: settledPayment.tier,
          }
        : null;

  if (identity) {
    const { accountId, accountKind, tier } = identity;
    // Own-property lookup ONLY. `config.tiers?.[tier]` walks the prototype
    // chain, and `tier` comes from the key-validation response -- an account on
    // a tier literally named "constructor", "toString", "valueOf" or
    // "__proto__" would resolve to the inherited Object member, which is
    // truthy, so the `|| config.keyed` fallback never ran. The resulting
    // "policy" has no `envVar`, the limiter binding lookup misses, and the
    // request is allowed with NO rate limiting at all -- a silent bypass.
    // Same class of bug as the `key in obj` check fixed in #8636.
    const policy =
      tier && Object.hasOwn(config.tiers ?? {}, tier)
        ? (config.tiers as Record<string, RateLimitTierPolicy>)[tier]
        : config.keyed;
    const limiter = rateLimiterBinding(env, policy.envVar);
    const result = {
      policy,
      tier: tier ?? "keyed",
      accountId,
      accountKind,
    };
    // #8611: the blocklist comes BEFORE any ceiling. A blocked caller is not
    // "going too fast", and spending their daily quota on requests we are about
    // to refuse would be wrong twice over -- they would be billed for units they
    // never got served, and the quota would mask the block as a 429.
    //
    // This deliberately does NOT ride the key-validation cache. That cache
    // holds a VALID key for 30 minutes (API_KEY_LOOKUP_KV_TTL) and is keyed by
    // a hash of the raw key we never store, so a block could neither be pushed
    // into it nor targeted for deletion -- an abusive key would keep working
    // for up to half an hour after someone hit block. The blocklist is its own
    // small snapshot on a short TTL instead, so a block lands within one
    // BLOCKLIST_KV_TTL rather than one identity-cache lifetime.
    const block = await loadBlockVerdict(env, accountId, accountKind);
    if (block.blocked) {
      return { allowed: false, ...result, block };
    }
    // #8812: per-minute limiter BEFORE the daily quota. spendDailyQuota is a
    // commit, not a check -- it debits units -- so it must run only for a
    // request the per-minute limiter has already accepted, otherwise a caller
    // refused with a 429 is still billed for a request that was never served
    // (the exact "wrong twice over" the blocklist comment above guards against,
    // applied one control down). The tradeoff: a caller simultaneously over the
    // day AND over the minute now gets the per-minute 429 rather than the daily
    // one -- accepted, because the alternative is billing for refused requests.
    if (limiter?.limit) {
      // Keyed by account AND tier: moving an account between tiers must start a
      // fresh window on the new ceiling rather than inheriting the old tier's
      // partially-spent one, which would otherwise let a downgrade be dodged (or
      // an upgrade be throttled) for the rest of the window.
      // An unattributable key falls back to its CLIENT IP rather than a shared
      // literal: it still gets its tier's ceiling (it does hold a valid key),
      // but it can never share a bucket with an unrelated caller.
      const { success } = await limiter.limit({
        // #11573: the id alone is not an identity -- `github_accounts.id` and
        // `rpc_accounts.id` are separate sequences in the same range, so the
        // kind is part of the bucket. `rpc` keeps its historical key shape so
        // no existing caller's window is reset by this change.
        key: `${config.keyPrefix}:${result.tier}:${
          accountId
            ? accountKind === DEFAULT_ACCOUNT_KIND
              ? accountId
              : `${accountKind}:${accountId}`
            : settledPayment
              ? // The wallet IS the identity for a paying caller, so their
                // budget follows the payer rather than the address they
                // happen to call from.
                `x402:${settledPayment.payer}`
              : `ip:${resolveClientIp(request)}`
        }`,
      });
      if (!success) return { allowed: false, ...result };
    }
    // The daily quota is debited against an rpc_accounts row. With no account
    // id there is no row to debit -- the old code sent `Number("null")`, i.e.
    // NaN, which the internal endpoint stored as a single shared `account_id:
    // null` row every unattributable key drew down together. Skipping is the
    // honest option: the per-minute ceiling above still bounds the caller.
    if (policy.dailyUnits && accountId !== null && deferQuota) {
      Object.assign(result, {
        quotaPending: { accountId, accountKind, dailyUnits: policy.dailyUnits },
      });
      return { allowed: true, ...result };
    }
    if (policy.dailyUnits && accountId !== null) {
      const quota = await spendDailyQuota(
        request,
        env,
        accountId,
        accountKind,
        policy.dailyUnits,
        costUnits,
      );
      if (quota && !quota.allowed) {
        return { allowed: false, ...result, quota };
      }
      if (quota) Object.assign(result, { quota });
    }
    return { allowed: true, ...result };
  }

  const policy = config.anonymous;
  const limiter = rateLimiterBinding(env, policy.envVar);
  // No identity at all. `accountKind` is still reported rather than left
  // undefined -- a consumer must never have to distinguish "anonymous" from
  // "we forgot to say", and `accountId: null` already carries the absence.
  const anonymous = {
    policy,
    tier: "anonymous",
    accountId: null,
    accountKind: DEFAULT_ACCOUNT_KIND,
  };
  if (!limiter?.limit) return { allowed: true, ...anonymous };
  const { success } = await limiter.limit({
    key: `${config.keyPrefix}:${resolveClientIp(request)}`,
  });
  return { allowed: success, ...anonymous };
}

/**
 * How a rejected request should be reported (#8611).
 *
 * A blocked caller must NOT get a 429. 429 means "slow down and retry", which
 * is advice that will never work here and invites exactly the retry storm a
 * block exists to stop. 403 with a stable reason code says "this will not
 * succeed until something changes", which is both true and actionable.
 *
 * `retry-after` is deliberately absent on a block: there is no time after
 * which it starts working again.
 */
export function tieredRejectionResponse(
  result: TieredRateLimitResult,
  rateLimited: { code: string; message: string },
): {
  status: number;
  code: string;
  message: string;
  headers: Record<string, string>;
} | null {
  if (result.allowed) return null;
  if (result.block?.blocked) {
    return {
      status: 403,
      code: "api_key_blocked",
      // The closed-set sentence, never the internal note -- that is written by
      // a maintainer for maintainers and can name people or suspicions.
      message: `${result.block.message} Contact support if you believe this is an error.`,
      headers: {
        "x-ratelimit-scope": "blocked",
        "x-api-key-block-reason": result.block.reasonCode ?? "abuse_manual",
        ...(result.tier ? { "x-ratelimit-tier": result.tier } : {}),
      },
    };
  }
  // The route's own 429 wording, passed in. Deliberately NOT a ternary at each
  // call site: four consumers each picking between a block message and their
  // own rate-limit message meant four duplicated two-way branches, and the
  // decision belongs here -- with the thing that knows which ceiling rejected
  // the caller -- not repeated in every handler.
  return {
    status: 429,
    ...rateLimited,
    headers: tieredRateLimitHeaders(result.policy, result.tier, result.quota),
  };
}

/**
 * Headers for a 429 raised by applyTieredRateLimit's result. `x-ratelimit-
 * remaining` is always "0" -- a 429 means the limit was hit, so that's true
 * by definition, not an estimate. `x-ratelimit-reset` is an upper-bound
 * APPROXIMATION (now + the window length), not the real window boundary --
 * Cloudflare's Rate Limiting binding (`.limit()`) only ever returns a
 * success/fail boolean, it exposes no remaining-count or exact reset instant
 * to derive an exact value from. Documented here rather than fabricating
 * precision the underlying primitive doesn't have.
 */
export function tieredRateLimitHeaders(
  policy: RateLimitTierPolicy,
  tier?: string,
  quota?: {
    allowed: boolean;
    used: number;
    limit: number;
    remaining: number;
    resetAt: string;
  },
): Record<string, string> {
  // #8608: a DAILY rejection reports the day's real numbers, not the minute's.
  // Its reset is an EXACT instant (next UTC midnight), unlike the per-minute
  // approximation below -- so a caller told to come back is told when, truly.
  //
  // Keyed on the store's own verdict, never on `remaining <= 0`: a 25-unit
  // call against 10 remaining units is a quota rejection with 10 remaining,
  // and reporting the per-minute ceiling for it would tell the caller to retry
  // in 60 seconds when the truth is "not until UTC midnight".
  if (quota && !quota.allowed) {
    return {
      "retry-after": String(
        Math.max(1, Math.ceil((Date.parse(quota.resetAt) - Date.now()) / 1000)),
      ),
      "x-ratelimit-limit": String(quota.limit),
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": quota.resetAt,
      "x-ratelimit-policy": `${quota.limit};w=86400`,
      "x-ratelimit-scope": "daily-quota",
      ...(tier ? { "x-ratelimit-tier": tier } : {}),
    };
  }
  const resetAt = new Date(
    Date.now() + policy.windowSeconds * 1000,
  ).toISOString();
  return {
    "retry-after": String(policy.windowSeconds),
    "x-ratelimit-limit": String(policy.limit),
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": resetAt,
    "x-ratelimit-policy": `${policy.limit};w=${policy.windowSeconds}`,
    // #8608: which ceiling this caller was measured against. Without it a 429
    // is unactionable -- a caller cannot tell "you are on free, upgrade" from
    // "you are on paid and genuinely over", which is the first question anyone
    // asks when they get rate limited.
    "x-ratelimit-scope": "per-minute",
    ...(tier ? { "x-ratelimit-tier": tier } : {}),
  };
}

/**
 * Debit a deferred daily quota once the caller knows what the request cost.
 *
 * Pair with `applyTieredRateLimit(..., { deferQuota: true })`. Returns the same
 * verdict shape `result.quota` would have carried, so `tieredRejectionResponse`
 * can label the 429 with the ceiling that actually rejected the caller.
 */
export async function spendDeferredDailyQuota(
  request: Request,
  env: Env,
  pending: { accountId: string; accountKind: AccountKind; dailyUnits: number },
  costUnits: number,
  // Nullable, because it forwards a nullable result -- see spendDailyQuota.
): Promise<(TieredRateLimitResult["quota"] & { allowed: boolean }) | null> {
  return spendDailyQuota(
    request,
    env,
    pending.accountId,
    pending.accountKind,
    pending.dailyUnits,
    costUnits,
  );
}
