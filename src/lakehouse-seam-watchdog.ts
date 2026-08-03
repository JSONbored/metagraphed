// Is the decode lane still moving, and is the seam still telling the truth?
//
// WHAT THIS USED TO WATCH, AND WHY IT MOVED. `DEFAULT_BLOCKS_SEAM` was the
// seam: a constant, compared here against `max(chain.blocks)` so a human would
// notice when a decode run left it behind. That check was correct for a seam
// only a human could move, and it is the wrong check now that the seam follows
// the decoder's own published watermark (src/decode-watermark.ts) -- "the
// constant disagrees with the lakehouse" is the NORMAL, self-correcting state
// of a floor.
//
// WHAT CAN ACTUALLY BREAK NOW, in the order it hurts:
//
//   1. NOTHING PUBLISHES. No watermark object at all, so the seam is pinned at
//      the floor forever -- exactly the failure the dynamic seam was built to
//      end, silently reintroduced.
//   2. THE DECODER STOPPED. The object exists but its timestamp has not moved.
//      The seam is then frozen at whatever the last run reached, and every
//      block after it serves reduced columns with no extrinsics and no events.
//      This is the shape that was live in production on 2026-08-03: block
//      headers at chain head, block DETAIL empty for 3,284 blocks.
//   3. THE DECODER IS RUNNING BUT LOSING. Publishing on time, and still
//      falling further behind the raw capture every tick.
//   4. THE WATERMARK IS AHEAD OF THE DATA. The dangerous direction, and the
//      only one that produces WRONG answers rather than thin ones: the seam
//      routes reads to a lakehouse that does not hold them, so blocks that
//      exist read as missing.
//   5. THE WATERMARK IS FAR BEHIND THE DATA. Rows are landing in chain.blocks
//      that no watermark advertises -- the publish half is broken while the
//      load half works.
//
// WHY A WORKER CRON, NOT A GITHUB ACTION. Unchanged from #9164: the check
// needs `R2_SQL_TOKEN`, the `METAGRAPH_ARCHIVE` bucket and the D1 binding, and
// this Worker already holds all three. An Actions job would need every one of
// them duplicated as a repository secret, plus a third-party trigger hop, to
// ask a question the Worker can ask itself.
import { r2SqlQuery } from "./r2-sql.ts";
import { blocksSeamFloor } from "./blocks-cold-tier.ts";
import {
  DECODE_WATERMARK_KEY,
  resolveDecodeWatermark,
  type DecodeWatermark,
} from "./decode-watermark.ts";
import { d1Watermark } from "./raw-capture-sync.ts";

/**
 * How long the decode lane may go without publishing before that is a fault.
 *
 * The lane runs hourly and retries a failed run on the platform's restart,
 * giving up after three consecutive failures (`DECODE_MAX_FAILURES`, private
 * repo's entrypoint-decode-r2.sh). Three hours is therefore the first moment
 * at which the lane has provably exhausted its OWN recovery budget rather than
 * merely having a slow or unlucky run: alarming at two hours would fire on one
 * long run plus cron jitter, and anything past three is time spent serving
 * detail-less blocks while the lane sits idle at its failure cap.
 */
export const DECODE_STALE_MS = 3 * 60 * 60 * 1000;

/**
 * How far the seam may trail the raw capture before that is a fault.
 *
 * Some lag is structural, not a fault: the capture lane runs every 5 minutes
 * and writes 150-block objects, the decode lane runs hourly and never splits a
 * capture object, and the chain adds ~300 blocks an hour. So a healthy seam
 * sits up to one partial capture object plus one hour of chain -- ~450 blocks
 * -- behind the capture even at the instant a run finishes.
 *
 * 2,400 blocks is ~8 hours of chain: over five times that structural ceiling,
 * so it cannot fire on healthy operation, and still only a sixth of the
 * decoder's 14,400-block single-run cap -- meaning the alarm arrives while ONE
 * ordinary run can still drain the whole backlog. A threshold above the cap
 * would only ever be read after the lane could no longer catch up by itself.
 */
export const DECODE_LAG_BLOCKS = 2_400;

export interface SeamVerdict {
  reasons: string[];
  summary: Record<string, unknown>;
}

export interface SeamInput {
  /** The configured floor -- what the seam falls back to. */
  floor: number;
  /** What the decoder published, or null when nothing could be read. */
  watermark: DecodeWatermark | null;
  /** raw_capture_state.last_contiguous_block, or null when unreadable. */
  capturedThrough: number | null;
  /** min/max/count over chain.blocks, or nulls when unmeasurable. */
  lo: number | null;
  hi: number | null;
  count: number | null;
  now: number;
}

const hours = (ms: number) => (ms / 3_600_000).toFixed(1);

/**
 * The whole decision, as a pure function of what was measured.
 *
 * Split out so the rule is testable without a lakehouse, a bucket or a D1 --
 * same split as `evaluateFreshness` and `evaluateSafeMode`. EVERY failing rule
 * contributes a reason: reporting only the first would turn one investigation
 * into several, and these failures co-occur (a decoder that stopped is also,
 * an hour later, a decoder that is behind).
 */
export function evaluateDecodeSeam({
  floor,
  watermark,
  capturedThrough,
  lo,
  hi,
  count,
  now,
}: SeamInput): SeamVerdict {
  const reasons: string[] = [];
  // Exactly what the serving path computes, so this watchdog is judging the
  // number requests actually route on rather than a reconstruction of it.
  const seam = Math.max(floor, watermark?.decodedThrough ?? floor);
  const age =
    watermark && watermark.updatedAt !== null
      ? now - watermark.updatedAt
      : null;

  if (watermark === null) {
    reasons.push(
      `no decode watermark could be read from ${DECODE_WATERMARK_KEY}: the seam is pinned at the configured floor ${floor} ` +
        "and cannot advance, so every block the decoder adds from here on serves with null author/spec_version/event_count " +
        "and no extrinsics or events at all",
    );
  } else if (age === null) {
    reasons.push(
      "the decode watermark carries no usable `updated_at`, so a stopped decoder is indistinguishable from a quiet one — " +
        "every completed run must rewrite this field even when it appended nothing",
    );
  } else if (age > DECODE_STALE_MS) {
    reasons.push(
      `the decode watermark is ${hours(age)}h old (threshold ${hours(DECODE_STALE_MS)}h): the decode lane has stopped publishing. ` +
        `The seam is frozen at ${seam}, so block detail above it is empty while the block list stays at chain head`,
    );
  }

  if (capturedThrough === null) {
    // Not fatal to the seam, but it is the yardstick for rules 3 and 5, so a
    // silent skip would hide a lag rather than report one.
    reasons.push(
      "could not read raw_capture_state.last_contiguous_block — the seam's lag behind the raw capture is unmeasurable this tick",
    );
  } else if (capturedThrough - seam > DECODE_LAG_BLOCKS) {
    reasons.push(
      `the seam trails the raw capture by ${capturedThrough - seam} block(s) (threshold ${DECODE_LAG_BLOCKS}): ` +
        `blocks ${seam + 1}..${capturedThrough} are captured as raw bytes but not decoded, so their extrinsics and events read as empty`,
    );
  }

  if (lo === null || hi === null || count === null) {
    // A failed read is not a passing check: staying quiet here would make an
    // unreachable lakehouse indistinguishable from a healthy one.
    reasons.push(
      "could not measure chain.blocks — the lakehouse is unreachable or the query failed",
    );
    return {
      reasons,
      summary: {
        seam,
        floor,
        lo,
        hi,
        count,
        captured_through: capturedThrough,
      },
    };
  }

  // count == hi - lo + 1 proves contiguity: no gaps AND no duplicates. A gap
  // below the seam is worse than a stale seam, because the seam sends those
  // reads to a source that does not have them at all.
  const expected = hi - lo + 1;
  if (count !== expected) {
    reasons.push(
      `chain.blocks is NOT contiguous: ${lo}..${hi} should hold ${expected} rows but holds ${count} ` +
        `(${expected - count} missing) — a gap below the seam is unreadable from either tier`,
    );
  }

  if (seam > hi) {
    // The one direction that answers WRONGLY rather than thinly. It should be
    // unreachable -- the ledger property is written in the same Iceberg commit
    // as the rows -- so if it happens the publisher's contract is broken.
    reasons.push(
      `the seam is ${seam - hi} block(s) AHEAD of the lakehouse: it resolves to ${seam} but chain.blocks stops at ${hi}. ` +
        `Blocks ${hi + 1}..${seam} route to a lakehouse that cannot answer, so they read as missing`,
    );
  } else if (hi - seam > DECODE_LAG_BLOCKS) {
    // Some lead is normal and self-correcting: the loader appends chain.blocks
    // before the other three tables and the watermark is the min across all
    // four, so a run in flight always shows a little. A sustained lead means
    // rows are landing that no watermark advertises.
    reasons.push(
      `the lakehouse holds ${hi - seam} block(s) the seam does not expose (threshold ${DECODE_LAG_BLOCKS}): ` +
        `chain.blocks reaches ${hi} but the published watermark resolves to ${seam}. Rows are being loaded without the watermark being republished`,
    );
  }

  return {
    reasons,
    summary: {
      seam,
      floor,
      watermark_decoded_through: watermark?.decodedThrough ?? null,
      watermark_age_ms: age,
      watermark_per_table: watermark?.perTable ?? null,
      captured_through: capturedThrough,
      capture_lag: capturedThrough === null ? null : capturedThrough - seam,
      lakehouse_lo: lo,
      lakehouse_hi: hi,
      lakehouse_count: count,
      contiguous: count === expected,
    },
  };
}

const num = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);

/** The raw-capture watermark, or null on any failure. Reuses the capture
 * lane's OWN reader so the two can never disagree about which row and column
 * hold the watermark. */
async function capturedThrough(env: unknown): Promise<number | null> {
  const db = (
    env as { METAGRAPH_HEALTH_DB?: Parameters<typeof d1Watermark>[0] }
  )?.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return null;
  try {
    // `Date.now` rather than a `() => 0` stub: the clock is only used by the
    // store's WRITE half, which this watchdog never calls, and an inline arrow
    // here would be a function nothing ever invokes.
    return await d1Watermark(db, Date.now).read();
  } catch {
    return null;
  }
}

/**
 * One watchdog tick: read what the decoder published, what the capture lane
 * reached, and what the lakehouse actually holds; judge them together.
 *
 * Returns a summary rather than throwing, matching runFreshnessWatchdog -- a
 * tick that cannot run is one missed report, not an outage, and a cron that
 * throws is a cron nobody can read the result of.
 */
export async function runLakehouseSeamWatchdog(
  env: Parameters<typeof r2SqlQuery>[0],
  // Injectable so the MEASURED path is testable without a lakehouse. Same seam
  // as r2-sql.ts's scheduleAbort and webhooks.ts's sleepFn: a branch that can
  // only run against live infrastructure is a branch nothing verifies.
  deps: { query?: typeof r2SqlQuery; now?: () => number } = {},
): Promise<Record<string, unknown>> {
  const query = deps.query ?? r2SqlQuery;
  const rows = await query(
    env,
    "SELECT min(block_number) AS lo, max(block_number) AS hi, count(*) AS n FROM chain.blocks",
  );
  // r2SqlQuery returns null when the lakehouse is UNCONFIGURED as well as when
  // a query fails. Unconfigured is not a fault -- self-hosters and CI have no
  // lakehouse -- so it is reported as skipped rather than as drift.
  if (rows === null) {
    return {
      ok: false,
      skipped: true,
      reason: "lakehouse_unavailable",
      seam: blocksSeamFloor(env),
    };
  }

  const row = rows[0];
  // `fresh` deliberately bypasses the serving memo: staleness is the thing
  // being measured, and a value up to a TTL old would understate it.
  const watermark = await resolveDecodeWatermark(env, { fresh: true });
  const { reasons, summary } = evaluateDecodeSeam({
    floor: blocksSeamFloor(env),
    watermark,
    capturedThrough: await capturedThrough(env),
    lo: num(row?.lo),
    hi: num(row?.hi),
    count: num(row?.n),
    now: (deps.now ?? Date.now)(),
  });

  return {
    // `ok` describes whether the TICK ran, not whether the seam is correct --
    // the drift itself is carried by `reasons`, and marking a successful check
    // as a failure would make the watchdog look broken every time it correctly
    // found something. Same convention as the freshness watchdog.
    ok: true,
    drifted: reasons.length > 0,
    reasons,
    ...summary,
  };
}
