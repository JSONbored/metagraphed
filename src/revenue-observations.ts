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

export const REVENUE_OBSERVATIONS_TABLE = "revenue_observations";
export const REVENUE_PROBE_FAILURES_TABLE = "revenue_probe_failures";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export interface RevenueStoreDb {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      run?(): Promise<unknown>;
      all?(): Promise<{ results?: unknown[] } | null>;
    };
  };
  batch?(statements: unknown[]): Promise<unknown>;
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
export async function persistRevenueProbe(
  db: RevenueStoreDb | null | undefined,
  result: RevenueProbeResult,
): Promise<{
  ok: boolean;
  written: number;
  failed: number;
  reason?: string;
}> {
  if (!db?.prepare) {
    return { ok: false, written: 0, failed: 0, reason: "no_store_binding" };
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
      await db
        .prepare(
          `INSERT INTO ${REVENUE_OBSERVATIONS_TABLE}` +
            ` (surface_id, netuid, period, grain, amount, currency, provenance, response_hash, observed_at)` +
            ` VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)` +
            ` ON CONFLICT (surface_id, period) DO UPDATE SET` +
            ` amount = EXCLUDED.amount, currency = EXCLUDED.currency,` +
            ` grain = EXCLUDED.grain, provenance = EXCLUDED.provenance,` +
            ` response_hash = EXCLUDED.response_hash, observed_at = EXCLUDED.observed_at`,
        )
        .bind(
          o.surface_id,
          o.netuid,
          o.period,
          o.grain,
          o.amount,
          o.currency,
          o.provenance,
          o.response_hash,
          o.observed_at,
        )
        .run?.();
    }
    // A fetch that failed is recorded as a failure, never as a zero. The
    // primary key is (surface_id, observed_at), so a retried tick at the same
    // millisecond updates rather than erroring the pass.
    for (const f of failures) {
      await db
        .prepare(
          `INSERT INTO ${REVENUE_PROBE_FAILURES_TABLE}` +
            ` (surface_id, netuid, reason, observed_at) VALUES (?, ?, ?, ?)` +
            ` ON CONFLICT (surface_id, observed_at) DO UPDATE SET reason = EXCLUDED.reason`,
        )
        .bind(f.surface_id, f.netuid, f.reason, f.observed_at)
        .run?.();
    }
  } catch (error) {
    return {
      ok: false,
      written: 0,
      failed: failures.length,
      reason: `write_failed: ${String((error as Error)?.message ?? error)}`,
    };
  }
  // A pass that observed nothing AND failed nothing probed nothing. That is a
  // real state -- every surface skipped as ineligible -- but it is not success,
  // because a lane silently probing an empty set looks exactly like one whose
  // every surface passed.
  return {
    ok: observations.length > 0 || failures.length === 0,
    written: observations.length,
    failed: failures.length,
    ...(observations.length === 0 && failures.length === 0
      ? { reason: "no_eligible_surfaces" }
      : {}),
  };
}

/** One pass, end to end: probe the eligible surfaces and persist what came back. */
export async function runRevenueProbeLane(
  surfaces: ProbeSurfaceInput[],
  db: RevenueStoreDb | null | undefined,
  deps: Parameters<typeof runRevenueProbe>[1],
): Promise<{
  ok: boolean;
  written: number;
  failed: number;
  skipped: number;
  reason?: string;
}> {
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
    const revenue = surface?.revenue as Row | undefined;
    if (!revenue) continue;
    // The two `extractRevenue` refuses without, checked in the order it checks
    // them so the reason a surface is skipped here matches the reason it would
    // have failed there.
    if (!revenue.shape || !revenue.currency) continue;
    out.push({
      id: String(surface.surface_id ?? ""),
      netuid: Number(surface.netuid),
      url: String(surface.url ?? ""),
      auth_required: surface.auth_required === true,
      probe: { enabled: true },
      revenue: surface.revenue,
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
export async function fetchRevenuePayload(
  url: string,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<{ payload: unknown; raw: string }> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
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
  if (!db?.prepare) return null;
  try {
    const where =
      netuid === null
        ? `WHERE currency = 'USD'`
        : `WHERE netuid = ? AND currency = 'USD'`;
    const statement = db
      .prepare(
        `SELECT surface_id, period, amount, response_hash, observed_at` +
          ` FROM ${REVENUE_OBSERVATIONS_TABLE} ${where}` +
          ` ORDER BY period DESC LIMIT ${Number(limit)}`,
      )
      .bind(...(netuid === null ? [] : [netuid]));
    const res = await statement.all?.();
    const rows = (res?.results ?? []) as Row[];
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

export const REVENUE_PROBE_QUEUE = "revenue-probes";

export async function enqueueRevenueProbes(
  queue: LaneQueue<RevenueProbeMessage> | null | undefined,
  surfaceIds: string[],
) {
  // The empty reason matters here more than anywhere: THIS lane shipped with no
  // caller and reported null for 129 subnets for two months (#10566).
  return enqueueAll(
    queue,
    surfaceIds.map((surface_id) => ({ surface_id })),
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
    run: async (surface) => (await runRevenueProbeLane([surface], db, deps)).ok,
  });
}
