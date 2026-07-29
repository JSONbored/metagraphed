// Per-key abuse controls (#8611): anomaly scoring and the key-level blocklist.
//
// Tier ceilings (#8608) stop one caller going too fast. They do not catch the
// patterns that actually cost us: a caller sitting at 95% of its ceiling around
// the clock, a key sweeping every route family in sequence (scraping), or one
// key clearly shared across many consumers. Those all stay perfectly inside the
// per-minute limit.
//
// Everything here is PURE. Signals are computed from usage rows the caller
// supplies and the blocklist is decided from a snapshot, so the whole policy is
// unit-testable without a database, and the Worker/script layers are left as
// plumbing. That split matters more than usual here: this is the code that can
// cut off a paying customer, so it has to be examinable in isolation.
//
// WHY NOT A SLIDING-WINDOW COUNTER. The obvious shape for abuse detection is a
// per-request sliding window, which is Redis's canonical job. It is not needed:
// every signal below is an aggregate over `api_key_usage_daily` /
// `api_quota_daily`, which the request path already maintains. Detection runs
// periodically against those tables and writes a small blocklist; the hot path
// reads a cached snapshot and never computes anything. That keeps enforcement
// at one KV read rather than a network round trip per request.

/**
 * Reason codes are a CLOSED set, not free text.
 *
 * A blocked caller is told why, and "why" ends up in support conversations,
 * dashboards and (eventually) an appeals path. Free-text reasons drift into
 * inconsistency and leak internal detail; a closed set can be translated,
 * counted, and reasoned about. `note` carries the specifics.
 */
export const BLOCK_REASON_CODES = {
  abuse_sustained_ceiling:
    "Sustained traffic at the tier ceiling over an extended period.",
  abuse_scraping:
    "Access pattern consistent with bulk scraping rather than integration use.",
  abuse_key_sharing:
    "Usage pattern indicates the key is shared across many independent consumers.",
  abuse_manual:
    "Blocked by a maintainer after review; see the accompanying note.",
  billing_unpaid: "Outstanding balance on the account.",
} as const;

export type BlockReasonCode = keyof typeof BLOCK_REASON_CODES;

export function isBlockReasonCode(value: unknown): value is BlockReasonCode {
  // Own-property lookup only. `value` arrives from an internal HTTP body, and
  // a prototype-chain hit on "constructor"/"toString" would sail through a
  // naive `in` or truthy index check -- the same class of bypass fixed in
  // #8687 and #8636.
  return typeof value === "string" && Object.hasOwn(BLOCK_REASON_CODES, value);
}

/** One account-day of usage, as stored in api_key_usage_daily. */
export interface UsageDay {
  day: string;
  /** Requests per route label ("chain-events", "mcp", "ask", ...). */
  routes: Record<string, number>;
}

export interface AnomalySignal {
  code: "sustained_ceiling" | "route_spread" | "single_route_concentration";
  /** 0..1. Not a probability -- a normalized severity for ranking a queue. */
  score: number;
  detail: string;
}

/**
 * Thresholds.
 *
 * Every one of these is a FLAG threshold, not a block threshold. Nothing here
 * blocks anybody: signals rank an internal review queue, and blocking is a
 * separate, deliberate action with its own reason code. That separation is the
 * point -- an automated block on a heuristic like "used many routes" would
 * eventually cut off a legitimate integration doing exactly what we built the
 * API for.
 */
export const SUSTAINED_CEILING_RATIO = 0.9;
export const SUSTAINED_CEILING_MIN_DAYS = 3;
export const ROUTE_SPREAD_MIN_ROUTES = 5;
export const SINGLE_ROUTE_CONCENTRATION_RATIO = 0.98;
export const SINGLE_ROUTE_MIN_REQUESTS = 10_000;

const totalOf = (routes: Record<string, number>): number =>
  Object.values(routes).reduce(
    (sum, count) => sum + (Number.isFinite(count) ? count : 0),
    0,
  );

/**
 * Score one account's recent usage.
 *
 * `dailyCeiling` is the account's tier ceiling expressed per DAY (per-minute
 * limit x 1440). Passed in rather than derived here so this module stays
 * independent of the rate-limit config, and so a caller can score against a
 * hypothetical tier.
 *
 * Returns every signal that fired, strongest first. An empty array means
 * nothing looked unusual -- which is the expected result for almost every key.
 */
export function scoreUsageAnomalies(
  days: UsageDay[],
  dailyCeiling: number,
): AnomalySignal[] {
  const signals: AnomalySignal[] = [];
  if (!Array.isArray(days) || days.length === 0) return signals;
  const usable = days.filter(
    (day) => day && typeof day.day === "string" && day.routes,
  );
  if (usable.length === 0) return signals;

  // 1. Sustained ceiling-riding. One busy day is a launch or a backfill; the
  //    same day repeated is a caller who has outgrown its tier or is using the
  //    ceiling as a throughput target.
  if (Number.isFinite(dailyCeiling) && dailyCeiling > 0) {
    const atCeiling = usable.filter(
      (day) => totalOf(day.routes) >= dailyCeiling * SUSTAINED_CEILING_RATIO,
    );
    if (atCeiling.length >= SUSTAINED_CEILING_MIN_DAYS) {
      signals.push({
        code: "sustained_ceiling",
        // Saturates at 2x the minimum run length: a 30-day run is not
        // meaningfully more suspicious than a 6-day one, and letting the score
        // grow without bound would push every long-lived heavy user to the top
        // of the queue forever.
        score: Math.min(1, atCeiling.length / (SUSTAINED_CEILING_MIN_DAYS * 2)),
        detail: `${atCeiling.length} of ${usable.length} days at >=${Math.round(
          SUSTAINED_CEILING_RATIO * 100,
        )}% of the daily ceiling`,
      });
    }
  }

  // 2. Route spread. A normal integration calls a handful of endpoints. A key
  //    touching every family we expose, every day, looks like enumeration.
  const routesPerDay = usable.map((day) => Object.keys(day.routes).length);
  const maxRoutes = Math.max(...routesPerDay);
  if (maxRoutes >= ROUTE_SPREAD_MIN_ROUTES) {
    signals.push({
      code: "route_spread",
      score: Math.min(1, maxRoutes / (ROUTE_SPREAD_MIN_ROUTES * 2)),
      detail: `touched ${maxRoutes} distinct route families in a single day`,
    });
  }

  // 3. Single-route concentration at volume. The opposite shape, and the more
  //    common one: hammering ONE endpoint hard enough that it is plainly a
  //    bulk pull rather than an integration. Gated on absolute volume so a
  //    small, single-purpose integration is never flagged for being focused.
  for (const day of usable) {
    const total = totalOf(day.routes);
    if (total < SINGLE_ROUTE_MIN_REQUESTS) continue;
    const top = Math.max(0, ...Object.values(day.routes));
    if (top / total >= SINGLE_ROUTE_CONCENTRATION_RATIO) {
      signals.push({
        code: "single_route_concentration",
        score: Math.min(1, total / (SINGLE_ROUTE_MIN_REQUESTS * 5)),
        detail: `${top} of ${total} requests on one route on ${day.day}`,
      });
      break;
    }
  }

  return signals.sort((a, b) => b.score - a.score);
}

/** An active block, as held in the cached snapshot the edge reads. */
export interface BlockEntry {
  accountId: number;
  reasonCode: BlockReasonCode;
  note?: string | null;
  blockedAt?: number | null;
}

export interface BlockVerdict {
  blocked: boolean;
  reasonCode: BlockReasonCode | null;
  /** Caller-facing sentence. Never the internal note, which may name a human. */
  message: string | null;
}

const NOT_BLOCKED: BlockVerdict = {
  blocked: false,
  reasonCode: null,
  message: null,
};

/**
 * Is this account blocked, per the snapshot?
 *
 * Fails OPEN on a missing or malformed snapshot, deliberately and for a
 * different reason than the rate-limit gate does. There, failing open avoids
 * throttling a paying caller. Here it avoids the far worse outcome of a
 * corrupt or half-written blocklist locking out every customer at once: the
 * blast radius of a false BLOCK is total, while a false allow costs one
 * interval of abuse from an already-known bad actor.
 *
 * The internal `note` is never surfaced. It is written by a maintainer for
 * maintainers and can name people, tickets or suspicions.
 */
export function evaluateBlock(
  snapshot: { blocks?: unknown } | null | undefined,
  accountId: unknown,
): BlockVerdict {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return NOT_BLOCKED;
  const blocks = snapshot?.blocks;
  if (!Array.isArray(blocks)) return NOT_BLOCKED;
  for (const entry of blocks as BlockEntry[]) {
    if (Number(entry?.accountId) !== id) continue;
    const reasonCode = isBlockReasonCode(entry?.reasonCode)
      ? entry.reasonCode
      : "abuse_manual";
    return {
      blocked: true,
      reasonCode,
      message: BLOCK_REASON_CODES[reasonCode],
    };
  }
  return NOT_BLOCKED;
}
