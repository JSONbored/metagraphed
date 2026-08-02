// Is the block seam still where the lakehouse actually ends? (#9161/#9164)
//
// `DEFAULT_BLOCKS_SEAM` routes every cold block read: at or below it the
// lakehouse answers with the full column set, above it D1's `blocks_head`
// answers with five columns and no `author`/`spec_version`/`event_count`. So a
// seam that lags the lakehouse does not fail -- it quietly serves reduced rows
// for a range where verified ones exist, and silently narrows any filter on
// those columns (see `d1CanServe`).
//
// It went stale exactly that way: a decoder extended the lakehouse 2,338 blocks
// past the constant and nothing re-measured it. `docs/disaster-recovery.md`
// already warned that "a stale one silently mis-routes reads" -- the warning was
// right and unenforced, which is what this watchdog fixes.
//
// WHY THIS IS A WORKER CRON, NOT A GITHUB ACTION. The check needs exactly one
// R2 SQL query, and this Worker already holds `R2_SQL_TOKEN` as a Worker secret
// -- an Actions job would need the same secret duplicated as a repository
// secret, plus a third-party trigger hop, to ask a question the Worker can ask
// itself. Same reasoning that moved the account-events rollup off
// rollup-account-events-daily.yml onto a Worker-native cron.
//
// Deriving the seam per request would be the WRONG fix, and blocks-cold-tier.ts
// argues that case correctly: a fixed height makes each block come from exactly
// one source, so the boundary is reproducible instead of depending on what the
// poller happened to retain. The seam stays a constant; this makes it
// impossible for that constant to drift unnoticed.
import { r2SqlQuery } from "./r2-sql.ts";
import { DEFAULT_BLOCKS_SEAM } from "./blocks-cold-tier.ts";

export interface SeamVerdict {
  reasons: string[];
  summary: Record<string, unknown>;
}

/**
 * The whole decision, as a pure function of what was measured.
 *
 * Split out so the rule is testable without a lakehouse -- same split as
 * `evaluateFreshness` and `evaluateSafeMode`.
 */
export function evaluateSeam({
  seam,
  lo,
  hi,
  count,
}: {
  seam: number;
  lo: number | null;
  hi: number | null;
  count: number | null;
}): SeamVerdict {
  const reasons: string[] = [];
  if (lo === null || hi === null || count === null) {
    // A failed read is not a passing check: staying quiet here would make an
    // unreachable lakehouse indistinguishable from a healthy one.
    reasons.push(
      "could not measure chain.blocks — the lakehouse is unreachable or the query failed",
    );
    return { reasons, summary: { seam, lo, hi, count } };
  }

  // count == hi - lo + 1 proves contiguity: no gaps AND no duplicates. A gap
  // below the seam is worse than a stale ceiling, because the seam sends those
  // reads to a source that does not have them at all.
  const expected = hi - lo + 1;
  if (count !== expected) {
    reasons.push(
      `chain.blocks is NOT contiguous: ${lo}..${hi} should hold ${expected} rows but holds ${count} ` +
        `(${expected - count} missing) — a gap below the seam is unreadable from either tier`,
    );
  }

  if (seam !== hi) {
    const drift = hi - seam;
    reasons.push(
      drift > 0
        ? `the seam lags the lakehouse by ${drift} block(s): DEFAULT_BLOCKS_SEAM is ${seam} but chain.blocks reaches ${hi}. ` +
            `Blocks ${seam + 1}..${hi} would be served from D1 blocks_head with null author/spec_version/event_count, ` +
            "and any filter on those columns silently narrows the answer, though the lakehouse holds full rows for them"
        : `the seam is ${-drift} block(s) AHEAD of the lakehouse: DEFAULT_BLOCKS_SEAM is ${seam} but chain.blocks stops at ${hi}. ` +
            `Blocks ${hi + 1}..${seam} route to a lakehouse that cannot answer, so they read as missing`,
    );
  }

  return {
    reasons,
    summary: {
      seam,
      lakehouse_lo: lo,
      lakehouse_hi: hi,
      lakehouse_count: count,
      contiguous: count === expected,
      drift: hi - seam,
    },
  };
}

const num = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);

/**
 * One watchdog tick: measure the lakehouse, compare it to the shipped seam.
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
  deps: { query?: typeof r2SqlQuery } = {},
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
      seam: DEFAULT_BLOCKS_SEAM,
    };
  }

  const row = rows[0];
  const { reasons, summary } = evaluateSeam({
    seam: DEFAULT_BLOCKS_SEAM,
    lo: num(row?.lo),
    hi: num(row?.hi),
    count: num(row?.n),
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
