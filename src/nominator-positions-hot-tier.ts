// GET /api/v1/accounts/{ss58}/positions, served from D1 -- the HOT leg (#9273).
//
// The lakehouse reader (#9266) made this route answer again; it could not make
// it answer CURRENTLY, because the ledger it reads is a frozen export nothing
// refreshes. This is the current leg: the same `nominator_positions` shape,
// written every pass by the revived sync lane (workers/data-api.ts's
// handleNominatorPositionsSync -> src/nominator-positions-d1-write.ts), read
// through the SAME buildAccountPositions formatter both other tiers fed. A
// caller cannot tell which tier answered.
//
// TIER ORDER IS HOT THEN COLD, and the switch is the ledger's own emptiness
// rather than a flag: until the lane has posted anything, `nominator_positions`
// is empty on D1 and this reader DECLINES so the lakehouse still answers; once
// it has, D1 is authoritative and the lakehouse is history. That makes the
// cutover a property of the data, not of a deploy -- there is no window where
// a config value and the table disagree about which tier is real.
//
// An empty table and a coldkey with no rows are DIFFERENT ANSWERS and are
// deliberately not collapsed: the first is "the lane has not run", the second
// is "this account holds nothing", and conflating them is the exact defect
// this issue is about. That is why the ledger's own MAX(captured_at) is read
// alongside the coldkey's rows rather than inferred from them.
//
// The stake leg is shared with the cold tier verbatim (neuronStakeByHotkeys,
// src/nominator-positions-cold-tier.ts): both tiers price positions off the
// live D1 `neurons` table, both chunk the IN-list at D1's 100-bound-parameter
// binding limit, and having one implementation is what keeps the two tiers
// from drifting into two different answers for the same coldkey.
import {
  annotatePositionsSnapshot,
  buildAccountPositions,
  distinctHotkeys,
} from "./account-nominator-positions.ts";
import {
  neuronStakeByHotkeys,
  POSITION_SCAN_CAP,
} from "./nominator-positions-cold-tier.ts";

/** The D1 surface this module needs -- structural, so tests can hand a plain
 * object (same pattern as src/nominator-positions-cold-tier.ts). */
interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all?(): Promise<{ results?: unknown[] } | null>;
      first?(): Promise<unknown>;
    };
    first?(): Promise<unknown>;
  };
}

/** Kept identical to the cold tier's SELECT list (minus `coldkey`, which the
 * predicate already fixes) so both tiers hand the formatter the same shape. */
const POSITION_COLUMNS = "hotkey, netuid, share_fraction, captured_at";

/**
 * One coldkey's current positions from D1, or null to let the caller fall
 * through to the lakehouse.
 *
 * Declines on: no binding, a failed read, an EMPTY ledger (the lane has not
 * posted yet), and a coldkey past POSITION_SCAN_CAP -- the last for the cold
 * tier's own stated reason, that `total_stake_alpha` is a sum over the whole
 * set, so a truncated scan publishes a confident number that is quietly too
 * small.
 */
export async function loadAccountPositionsD1(
  env: Env | null | undefined,
  ss58: string,
): Promise<ReturnType<typeof buildAccountPositions> | null> {
  const db = (env as { METAGRAPH_HEALTH_DB?: D1Like } | null | undefined)
    ?.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return null;

  let rows: Record<string, unknown>[];
  let ledgerCapturedAt: number | null;
  try {
    // Issued together: the ledger stamp is needed on the zero path and the
    // decline path alike, and serialising two independent point reads on a
    // request path buys nothing.
    const [positionsResult, latestRow] = await Promise.all([
      db
        .prepare(
          `SELECT ${POSITION_COLUMNS} FROM nominator_positions` +
            ` WHERE coldkey = ? LIMIT ?`,
        )
        // One row over the cap is enough to know the cap was exceeded, and
        // cheaper than a second counting query over the same predicate.
        .bind(ss58, POSITION_SCAN_CAP + 1)
        .all?.(),
      db
        .prepare("SELECT MAX(captured_at) AS latest FROM nominator_positions")
        .first?.(),
    ]);
    if (!Array.isArray(positionsResult?.results)) {
      throw new Error("nominator_positions: no rows");
    }
    rows = positionsResult.results as Record<string, unknown>[];
    const latest = (latestRow as { latest?: unknown } | null)?.latest;
    ledgerCapturedAt = typeof latest === "number" ? latest : null;
  } catch {
    return null;
  }

  // An empty ledger is the pre-cutover state, not an answer.
  if (ledgerCapturedAt === null) return null;
  if (rows.length > POSITION_SCAN_CAP) return null;

  const stake = await neuronStakeByHotkeys(env, distinctHotkeys(rows));
  if (stake === null) return null;

  // A zero here is a LIVE zero, so it needs no stake-event cross-check -- but
  // it still gets the ledger's stamp, so a caller can see the answer is
  // current rather than inheriting the null a rowless account used to get.
  return annotatePositionsSnapshot(buildAccountPositions(rows, stake, ss58), {
    snapshotCapturedAtMs: ledgerCapturedAt,
    latestStakeEventMs: null,
  });
}
