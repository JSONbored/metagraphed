// #10566: the revenue probe lane's store — the producer half, and the read the
// serving layer needs.
//
// src/revenue-probe.ts has existed since #10444 and NOTHING CALLED IT. No
// workers/ module imported it and no wrangler config carried a cron, so
// `revenue_observations` was never written, and every revenue route reported
// `revenue_usd: null` for all 129 subnets -- including the two the epic exists
// to measure.
//
// Nothing failed, which is the part worth stating. The epic's own rule is that
// absent revenue serialises as null rather than zero, so a dead producer is
// indistinguishable from the correct, honest answer for 127 of 129 subnets.
// There was no error, no empty-artifact alarm, and no lane verdict, because
// there was no lane.
//
// Two writes, deliberately to two tables. A failure has no amount, and giving
// it a nullable amount column would invite a reader to coalesce it to 0 -- the
// exact confusion the lane exists to prevent (see migrations/neon/0016).
import {
  READABLE_PROVENANCES,
  runRevenueProbe,
  type ProbeSurfaceInput,
  type RevenueProbeResult,
} from "./revenue-probe.ts";
import type { RevenueObservation } from "./revenue-serving.ts";
import {
  consumeBatch,
  enqueueAll,
  type ConsumeResult,
  type LaneMessage,
  type LaneQueue,
} from "./lane-queue.ts";
import { probeJob } from "./probe-jobs.ts";

export const REVENUE_OBSERVATIONS_TABLE = "revenue_observations";
export const REVENUE_PROBE_FAILURES_TABLE = "revenue_probe_failures";

type Row = Record<string, unknown>;

/** The minimal producer-store surface used here (src/producer-store.ts),
 * structural so tests can inject a plain object. */
export interface RevenueStoreDb {
  query?<Row>(text: string, values?: unknown[]): Promise<Row[]>;
  run?(text: string, values?: unknown[]): Promise<{ changes: number }>;
}

/**
 * Persist one pass.
 *
 * NEVER THROWS. A capture lane that could take down the cron it runs on would
 * be worse than a gap in the series -- the same posture captureSubnetBurnHistory
 * holds, and for the same reason. The verdict comes back as a value so the
 * dispatch can record it rather than discard it, which is how #10172's frozen
 * series went unnoticed for five hours.
 */
/**
 * What a probe pass did, and -- when it declined -- WHY.
 *
 * A DECLINE ALWAYS CARRIES A REASON, at the type level. One shape with
 * `reason?: string` let every caller collapse the outcome to a boolean and lose
 * the diagnosis, which is what left the retry report reading "run() declined
 * without throwing" while this function had already computed the answer.
 * Splitting the union makes the compiler ask, and removes the `?? false`
 * fallback that would otherwise be a branch no test could reach.
 *
 * `ok: true` may still carry a reason: a pass that probed an empty eligible set
 * succeeded and is still worth explaining.
 */
export type RevenueProbeOutcome = {
  written: number;
  failed: number;
  /**
   * Whether redelivering this work could produce a different answer (#10855).
   *
   * SEPARATE FROM `ok`, because `ok` answers "did this pass produce anything"
   * -- a lane-verdict question -- and the queue needs a different one: "is
   * asking again worth a round trip against somebody else's API". Conflating
   * them is what dead-lettered a deterministic extraction failure hourly.
   */
  retryable: boolean;
} & ({ ok: true; reason?: string } | { ok: false; reason: string });

export async function persistRevenueProbe(
  db: RevenueStoreDb | null | undefined,
  result: RevenueProbeResult,
): Promise<RevenueProbeOutcome> {
  if (!db?.run) {
    // Nothing was recorded, so the next delivery is the only chance this work
    // gets. Retryable even though a missing binding will not fix itself: the
    // alternative is acking work that left no trace anywhere.
    return {
      ok: false,
      written: 0,
      failed: 0,
      retryable: true,
      reason: "no_store_binding",
    };
  }
  const { observations, failures } = result;
  try {
    // ON CONFLICT DO UPDATE, never INSERT OR REPLACE: the latter is SQLite's
    // spelling and Postgres rejects it outright as a syntax error, which is how
    // every write in the burn lane failed silently the moment its table became
    // sole-store on Neon (#10172).
    //
    // The upsert is the point, not just idempotence. Both SN64 and SN51 restate
    // history -- a rolling window of daily rows, a growing map of months -- so
    // the same period is observed on every tick and the newest reading wins.
    // Appending instead would grow ~30 rows per surface per tick and make the
    // serving read a per-period argmax over duplicates.
    for (const o of observations) {
      await db.run(
        `INSERT INTO ${REVENUE_OBSERVATIONS_TABLE}` +
          ` (surface_id, netuid, period, grain, amount, currency, provenance, response_hash, observed_at)` +
          ` VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)` +
          ` ON CONFLICT (surface_id, period) DO UPDATE SET` +
          ` amount = EXCLUDED.amount, currency = EXCLUDED.currency,` +
          ` grain = EXCLUDED.grain, provenance = EXCLUDED.provenance,` +
          ` response_hash = EXCLUDED.response_hash, observed_at = EXCLUDED.observed_at`,
        [
          o.surface_id,
          o.netuid,
          o.period,
          o.grain,
          o.amount,
          o.currency,
          o.provenance,
          o.response_hash,
          o.observed_at,
        ],
      );
    }
    // A fetch that failed is recorded as a failure, never as a zero. The
    // primary key is (surface_id, observed_at), so a retried tick at the same
    // millisecond updates rather than erroring the pass.
    for (const f of failures) {
      await db.run(
        `INSERT INTO ${REVENUE_PROBE_FAILURES_TABLE}` +
          ` (surface_id, netuid, reason, observed_at) VALUES (?, ?, ?, ?)` +
          ` ON CONFLICT (surface_id, observed_at) DO UPDATE SET reason = EXCLUDED.reason`,
        [f.surface_id, f.netuid, f.reason, f.observed_at],
      );
    }
  } catch (error) {
    return {
      ok: false,
      written: 0,
      failed: failures.length,
      // The rows did NOT land, so this is the one failure a retry can fix.
      retryable: true,
      reason: `write_failed: ${String((error as Error)?.message ?? error)}`,
    };
  }
  // A pass that observed nothing AND failed nothing probed nothing. That is a
  // real state -- every surface skipped as ineligible -- but it is not success,
  // because a lane silently probing an empty set looks exactly like one whose
  // every surface passed.
  const counts = { written: observations.length, failed: failures.length };
  // The rows ARE on disk by here. Only a transient failure is worth another
  // delivery; a terminal one would re-fetch and rewrite the identical row.
  const retryable = failures.some((failure) => !failure.terminal);
  // A pass that wrote nothing and failed something is the ONE decline this
  // function used to make without saying why -- the only branch that set a
  // reason was the probed-nothing case below. So the diagnosis travelled to
  // `revenue_probe_failures`, which no route, watchdog or serving surface
  // reads, and the retry report said "run() declined without throwing".
  //
  // Measured 2026-08-15: `sn-51-lium-revenue-for-validators` dead-lettered
  // roughly hourly for 3.7 days in exactly this state, while its endpoint
  // answered 200 and this repo's own extractor turned that payload into 20
  // valid observations.
  //
  // THE SUBJECT RIDES WITH THE REASON: "fetch failed: HTTP 503" with no surface
  // named is the same dead end one layer down. Bounded to two and a count,
  // because a lane whose dependency is down fails every surface identically and
  // a reason string is not a log.
  if (observations.length === 0 && failures.length > 0) {
    const named = failures
      .slice(0, 2)
      .map((failure) => `${failure.surface_id}: ${failure.reason}`)
      .join("; ");
    const more = failures.length > 2 ? ` (+${failures.length - 2} more)` : "";
    return { ...counts, ok: false, retryable, reason: `${named}${more}` };
  }
  // A pass that observed nothing AND failed nothing probed nothing. That is a
  // real state -- every surface skipped as ineligible -- but it is not success,
  // because a lane silently probing an empty set looks exactly like one whose
  // every surface passed.
  if (observations.length === 0) {
    return { ...counts, ok: true, retryable, reason: "no_eligible_surfaces" };
  }
  return { ...counts, ok: true, retryable };
}

/** One pass, end to end: probe the eligible surfaces and persist what came back. */
export async function runRevenueProbeLane(
  surfaces: ProbeSurfaceInput[],
  db: RevenueStoreDb | null | undefined,
  deps: Parameters<typeof runRevenueProbe>[1],
  // DERIVED from the store's outcome rather than restated. This re-declared the
  // shape with `reason?: string`, which collapsed the union one layer above and
  // put the maybe back -- so the handler could not tell that a decline always
  // carries a reason, and had to fall back to a branch no test could reach.
): Promise<RevenueProbeOutcome & { skipped: number }> {
  const result = await runRevenueProbe(surfaces, deps);
  const persisted = await persistRevenueProbe(db, result);
  return { ...persisted, skipped: result.skipped.length };
}

export const OPERATIONAL_SURFACES_ARTIFACT = "/metagraph/operational-surfaces";

/**
 * The lane's input set, from the artifact that already holds it.
 *
 * `operational-surfaces.json` is built from exactly the surfaces that are
 * probe-enabled AND public-safe (scripts/build-artifacts.ts's own filter), so
 * membership carries `probe.enabled: true` -- the projection drops the flag
 * because every row in the file has it. probeEligibility still checks it, so it
 * is restored here rather than assumed away, and
 * tests/revenue-observations.test.ts pins the build filter that makes it true.
 *
 * ## ELIGIBLE MEANS EXTRACTABLE, NOT MERELY ANNOTATED (#10783)
 *
 * The test was `!surface.revenue` -- any revenue block at all. `extractRevenue`
 * opens with `if (!shape) return fail("no shape declared")` and fails the same
 * way on a missing `currency`, so a surface carrying only `{provenance, role}`
 * is one this lane can fetch and can never read.
 *
 * Measured on the live artifact 2026-08-11: 632 surfaces, **35** with a revenue
 * block, **5** with a shape and a currency. So every hour the producer enqueued
 * 35 messages, 30 of which were guaranteed to fetch a 200 and then fail
 * extraction -- 30 wasted round trips against other people's APIs, 30 failure
 * rows an hour, and the retries behind them are what put messages on
 * `revenue-probes-dlq`. `/api/v1/chain/revenue-coverage` reported
 * `observed_count: 1` of 129 subnets throughout.
 *
 * The 30 are not broken registry entries. `role: "not-revenue"` is a real and
 * useful annotation -- it records that somebody looked at a surface and
 * concluded it does not report revenue -- and so is a bare `provenance`. They
 * are simply not probe inputs, and eligibility asking a different question from
 * extraction is what made them look like ones.
 *
 * WHAT IS DELIBERATELY NOT CHECKED HERE: whether `shape` is in the
 * REVENUE_SHAPES vocabulary. `extractRevenue` validates that and fails with
 * `unknown shape "..."`, which writes a failure row naming the surface -- and a
 * typo'd shape in the registry is exactly the thing that failure row should
 * surface. Filtering it out here would make a registry error look like a
 * surface that was never meant to be probed.
 */
export function eligibleRevenueSurfaces(
  artifact: Row | null | undefined,
): ProbeSurfaceInput[] {
  const surfaces = Array.isArray(artifact?.surfaces) ? artifact.surfaces : [];
  const out: ProbeSurfaceInput[] = [];
  for (const surface of surfaces as Row[]) {
    // The registry's own declaration, asserted at the SAME boundary the
    // artifact read already is -- narrower than the `as Row` it replaces, not
    // an additional claim. It says what the object IS, never that its members
    // are valid: `extractRevenue` validates `shape` against REVENUE_SHAPES
    // itself, which is the whole point of the paragraph above (#10782).
    const revenue = surface?.revenue as ProbeSurfaceInput["revenue"];
    if (!revenue) continue;
    // The two `extractRevenue` refuses without, checked in the order it checks
    // them so the reason a surface is skipped here matches the reason it would
    // have failed there.
    if (!revenue.shape || !revenue.currency) continue;
    // AND THE TWO `probeEligibility` REFUSES WITHOUT, which this claimed to
    // mirror and did not.
    //
    // The comment above says a surface skipped here is skipped for the reason
    // it would have failed later. That was only ever true of `extractRevenue`.
    // `probeEligibility` -- the gate the lane actually applies on delivery --
    // opens with `role !== "external-revenue"` and then a readable
    // `provenance`, and neither was asked here, so a surface that can never be
    // probed was enqueued anyway, once an hour, forever.
    //
    // Measured 2026-08-15 against the published artifact: five surfaces carry a
    // shape and a currency, and `sn-64-chutes-invocations-usage` is
    // `role: "usage-proxy"` -- a usage signal, deliberately not revenue. The
    // `revenue-probe` lane's verdict read `5 enqueued` every hour while four is
    // the true number, so the count a reader judges the lane by overstated it.
    //
    // The other two gates are deliberately NOT copied. `auth_required` is
    // carried below and checked there; `probe.enabled` is ASSERTED below rather
    // than read, because the operational-surfaces artifact carries no `probe`
    // block at all -- reading it here would make every surface ineligible and
    // stop the lane dead. See the test that pins that to the build filter.
    if (revenue.role !== "external-revenue") continue;
    if (
      !(READABLE_PROVENANCES as readonly string[]).includes(
        revenue.provenance ?? "",
      )
    ) {
      continue;
    }
    out.push({
      id: String(surface.surface_id ?? ""),
      netuid: Number(surface.netuid),
      url: String(surface.url ?? ""),
      auth_required: surface.auth_required === true,
      probe: { enabled: true },
      revenue,
    });
  }
  return out;
}

/** sha-256 of the exact bytes a figure was extracted from. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Fetch one surface, returning the parsed body and the exact text it came from.
 *
 * Throwing IS the failure path -- runRevenueProbe catches it and records a
 * failure row. A non-2xx is a throw for the same reason: an operator returning
 * a 500 with a JSON error body must not have that body handed to an extractor,
 * which would read a field name off it and write whatever it found.
 */
/**
 * How this lane identifies itself to somebody else's billing API.
 *
 * Matches the probe family's spelling (`metagraphed-smoke-probe/0.0`,
 * `metagraphed-subtensor-rpc-probe/0.0`) so an operator grepping their access
 * log sees one recognisable family rather than four unrelated strings.
 */
export const REVENUE_PROBE_USER_AGENT = "metagraphed-revenue-probe/0.0";

export async function fetchRevenuePayload(
  url: string,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<{ payload: unknown; raw: string }> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      // NAMED, and this is not a courtesy -- it is what makes the lane work.
      //
      // Workers send no User-Agent by default, and a WAF that refuses UA-less
      // traffic answers 403. Measured 2026-08-15 against
      // https://lium.io/api/billing/revenue-for-validators:
      //
      //   no User-Agent header     -> 403  (3/3)
      //   any User-Agent           -> 200
      //
      // That is the whole of SN51's outage. The surface was never down: a plain
      // curl and the live cron health prober both got 200 throughout, the
      // prober because src/health-probe-core.ts has always sent
      // `metagraphed-smoke-probe/0.0`. This lane was the one caller not
      // identifying itself, so it 403'd, wrote a failure row, retried, and
      // dead-lettered roughly hourly for 3.7 days -- while the payload it could
      // not reach parses into 20 valid monthly observations.
      //
      // Same shape as every other outbound identity in this repo, so an
      // operator reading their logs can tell who we are and rate-limit us
      // deliberately rather than by accident.
      "user-agent": REVENUE_PROBE_USER_AGENT,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const raw = await response.text();
  return { payload: JSON.parse(raw) as unknown, raw };
}

/**
 * The observation series the serving layer windows over.
 *
 * ONLY USD ROWS. The declaration schema permits `TAO` and `ALPHA`, and a
 * TAO-denominated figure would need the tao-usd index at each observation's own
 * instant to become comparable -- which is a real conversion, not a cast. Rather
 * than filter here and let a non-USD surface read back as "not observed",
 * `validate:revenue-provenance` refuses a readable external-revenue declaration
 * that is not USD, so the filter below can only ever match everything. It stays
 * as the second half of that pair: the gate stops one being declared, this stops
 * one being served if it somehow is.
 *
 * Null on a read failure, NOT an empty array -- an empty series is a real answer
 * (nothing observed yet) and a failed read is not, and the two must not converge.
 */
export async function loadRevenueObservations(
  db: RevenueStoreDb | null | undefined,
  netuid: number | null,
  { limit = 4000 }: { limit?: number } = {},
): Promise<Map<string, RevenueObservation[]> | null> {
  if (!db?.query) return null;
  try {
    const where =
      netuid === null
        ? `WHERE currency = 'USD'`
        : `WHERE netuid = ? AND currency = 'USD'`;
    const rows = await db.query<Row>(
      `SELECT surface_id, period, amount, response_hash, observed_at` +
        ` FROM ${REVENUE_OBSERVATIONS_TABLE} ${where}` +
        ` ORDER BY period DESC LIMIT ${Number(limit)}`,
      netuid === null ? [] : [netuid],
    );
    const bySurface = new Map<string, RevenueObservation[]>();
    for (const row of rows) {
      const surface_id = String(row.surface_id ?? "");
      const amount = Number(row.amount);
      if (!surface_id || !Number.isFinite(amount)) continue;
      const list = bySurface.get(surface_id) ?? [];
      list.push({
        surface_id,
        period: String(row.period ?? ""),
        amount_usd: amount,
        response_hash:
          row.response_hash == null ? null : String(row.response_hash),
        observed_at: toIsoOrNull(row.observed_at),
      });
      bySurface.set(surface_id, list);
    }
    return bySurface;
  } catch {
    return null;
  }
}

/** Epoch-millis to ISO, or null. Mirrors subnet-burn-history's own helper. */
function toIsoOrNull(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// ── the queue lane ──────────────────────────────────────────────────────────
//
// REPLACES runRevenueProbeTick, which fetched every eligible surface inside one
// scheduled invocation. Two surfaces are eligible today so it fit, and that is
// precisely the problem: the lane was correct only while the number stayed
// small, and #10464's sweep exists to grow it.
//
// One message per surface is one invocation per surface. A surface whose feed
// times out is retried on its own instead of costing the pass; one that keeps
// failing reaches the dead-letter queue, which src/dead-letter.ts records as a
// lane verdict rather than leaving `revenue_probe_failures` to accumulate rows
// while the lane itself looks healthy.

/** One surface to probe. The eligible set is re-read at DELIVERY, so a message
 * that waited cannot probe a surface the registry has since withdrawn. */
export interface RevenueProbeMessage {
  surface_id: string;
}

export async function enqueueRevenueProbes(
  queue: LaneQueue<RevenueProbeMessage> | null | undefined,
  surfaceIds: string[],
) {
  // The empty reason matters here more than anywhere: THIS lane shipped with no
  // caller and reported null for 129 subnets for two months (#10566).
  return enqueueAll(
    queue,
    surfaceIds.map((surface_id) => probeJob("revenue-probe", { surface_id })),
    "no_eligible_surfaces",
  );
}

/** Probe one surface. A surface no longer in the eligible set parses to NULL --
 * acked, not retried, because the registry withdrew it and redelivery will not
 * bring it back. */
export async function handleRevenueProbeBatch(
  messages: LaneMessage[],
  db: RevenueStoreDb | null | undefined,
  deps: Parameters<typeof runRevenueProbeLane>[2] & {
    /** The eligible surfaces, re-read at DELIVERY time. */
    surfaceFor: (id: string) => ProbeSurfaceInput | null;
  },
): Promise<ConsumeResult> {
  return consumeBatch(messages, {
    parse: (body) => {
      const id = (body as RevenueProbeMessage | null)?.surface_id;
      if (typeof id !== "string" || !id) return null;
      return deps.surfaceFor(id);
    },
    run: async (surface) => {
      const outcome = await runRevenueProbeLane([surface], db, deps);
      // ACKED WHEN THERE IS NOTHING LEFT TO ASK (#10855). `consumeBatch` retries
      // on a falsy return, so returning `ok` alone sent every deterministic
      // extraction failure round the retry loop and then to
      // `revenue-probes-dlq` -- hourly, for as long as the declaration and the
      // payload disagreed. The failure row is already written by then, so the
      // retry bought a second identical row and a second request against
      // somebody else's API.
      //
      // A transient failure still retries: `retryable` is true for a fetch that
      // threw and for a write that did not land.
      // Split rather than `||`ed, so the union narrows: after both guards
      // `outcome` is the decline arm and its reason is a string, not a maybe.
      if (outcome.ok) return true;
      if (!outcome.retryable) return true;
      // THE REASON, not just the decline. The union above guarantees a decline
      // carries one, so there is no `?? false` fallback and no branch a test
      // could not reach.
      return outcome.reason;
    },
  });
}
