// GET /api/v1/accounts/{ss58}/positions, served from the lakehouse.
//
// `nominator_positions` was Postgres-only, so with the box gone this route
// answered `positions: 0` for every coldkey on the network -- schema-stable
// and honest, and wrong about the one thing it exists to say. The ledger is
// in the lakehouse (153,611 rows, verified live 2026-08-03), so this reader
// serves it through the SAME `buildAccountPositions` formatter the Postgres
// tier fed: a caller cannot tell which tier answered.
//
// TWO TIERS, ONE ANSWER. `nominator_positions` is a share-fraction ledger --
// `share_fraction` is dimensionless, this coldkey's slice of a hotkey's
// alpha-pool shares on one subnet, with no stake figure of its own (see
// src/account-nominator-positions.ts's header for why it is stored that way).
// The stake side comes from `neurons`, which lives on D1 and is current, so
// this read is lakehouse-for-the-ledger + D1-for-the-stake -- exactly the
// split the retired Postgres route already ran once `neurons` moved to D1
// (it called loadNeuronStakeByHotkeysD1 from inside the Postgres dispatcher).
// The lakehouse copy of `neurons` is deliberately NOT used: it is a frozen
// export, and pricing a live position off it would quietly age every
// stake_tao in the payload.
//
// D1 CAPS BOUND PARAMETERS AT 100 PER STATEMENT. The retired loader built one
// `hotkey IN ($1..$n)` list for every hotkey a coldkey delegates to; the
// heaviest coldkey in the ledger references 460 distinct hotkeys (measured),
// so the same statement would be rejected by the binding. The IN-list is
// therefore chunked at the platform limit and the chunks issued together --
// asserting the limit rather than the count, because the count grows with the
// network and the limit does not.
//
// DECLINE, NEVER TRUNCATE. Both legs return null on any failure so the route
// keeps the schema-stable empty card it already has. The position scan is
// capped and a coldkey past the cap DECLINES rather than serving its first N
// rows: `total_stake_alpha` is a sum over the whole set, so a truncated scan
// would publish a confident number that is quietly too small -- worse than
// the empty it replaced. Same for a partial stake map: a chunk that fails
// would drop every position it covered, and buildAccountPositions has no way
// to tell a dropped hotkey from a deregistered one.
//
// #9273 -- THE ZERO THIS TIER USED TO PUBLISH. The ledger it reads is a frozen
// export (captured 2026-08-02) and nothing refreshes it, so a coldkey that
// began delegating after that date has no rows here and got
// `positions: 0, total_stake_alpha: 0` with a NULL captured_at: a confident,
// unfalsifiable wrong answer. Four of five coldkeys sampled from a live
// /validators/{hotkey}/nominators response -- all provably delegating right
// now -- came back that way. So when this tier resolves to zero it now reads
// two more facts and says what it actually knows: the ledger's own capture
// stamp (so the age of the answer is visible even with no rows to derive it
// from), and this coldkey's newest on-chain stake event. A stake event newer
// than the ledger contradicts the zero, and the payload says so
// (`degraded.reason: snapshot_predates_stake_activity`) instead of asserting
// it. Both reads are issued ONLY on the zero path, in parallel with each
// other, and the ledger stamp is memoized per isolate -- it moves at most once
// per lane tick and is identical for every caller.
import {
  annotatePositionsSnapshot,
  buildAccountPositions,
  distinctHotkeys,
  stakeByHotkeyNetuid,
} from "./account-nominator-positions.ts";
import { STAKE_ADDED_KIND, STAKE_REMOVED_KIND } from "./account-stake-flow.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";
import { r2SqlQuery, safeSs58Literal } from "./r2-sql.ts";

/** Kept identical to the retired Postgres tier's SELECT list (minus `coldkey`,
 * which the predicate already fixes) so both tiers hand the formatter the
 * same shape. */
const POSITION_COLUMNS = "hotkey, netuid, share_fraction, captured_at";

/**
 * The most positions one coldkey may hold and still be served.
 *
 * Measured live 2026-08-03: the heaviest coldkey in the ledger holds 794
 * positions across 460 distinct hotkeys, so 2,000 is ~2.5x the real ceiling
 * and still bounds the D1 fan-out below at 20 chunked statements. A coldkey
 * past it declines (see the header) rather than publishing a partial total.
 */
export const POSITION_SCAN_CAP = 2_000;

/**
 * D1's hard limit on bound parameters in one prepared statement.
 *
 * The platform's number, not a tuning knob: `wrangler d1 execute` permits far
 * more from the CLI, which is why this ceiling is easy to miss locally and
 * still rejects the identical statement through a binding.
 */
export const D1_BIND_PARAM_CAP = 100;

/** The D1 surface this module needs from `neurons` -- structural, so tests can
 * hand a plain object (same pattern as src/account-feeds-cold-tier.ts). */
interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all?(): Promise<{ results?: unknown[] } | null>;
    };
  };
}

/**
 * `neurons.stake_tao` for every (hotkey, netuid) a coldkey's positions
 * reference, as buildAccountPositions' join map -- or null when any chunk
 * cannot be read.
 *
 * No hotkeys means no query and an empty map, mirroring the retired loader's
 * own early return: an account with no positions is a legitimate empty card,
 * not a decline.
 */
export async function neuronStakeByHotkeys(
  env: Env | null | undefined,
  hotkeys: string[],
): Promise<Map<string, number> | null> {
  if (hotkeys.length === 0) return new Map();
  const db = (env as { METAGRAPH_HEALTH_DB?: D1Like } | null | undefined)
    ?.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return null;
  const chunks: string[][] = [];
  for (let i = 0; i < hotkeys.length; i += D1_BIND_PARAM_CAP) {
    chunks.push(hotkeys.slice(i, i + D1_BIND_PARAM_CAP));
  }
  let results: unknown[][];
  try {
    results = await Promise.all(
      chunks.map(async (chunk) => {
        const placeholders = chunk.map(() => "?").join(", ");
        const res = await db
          .prepare(
            `SELECT hotkey, netuid, stake_tao FROM neurons WHERE hotkey IN (${placeholders})`,
          )
          .bind(...chunk)
          .all?.();
        if (!Array.isArray(res?.results)) throw new Error("neurons: no rows");
        return res.results;
      }),
    );
  } catch {
    return null;
  }
  return stakeByHotkeyNetuid(results.flat() as Record<string, unknown>[]);
}

/** First finite non-negative `latest` cell of a MAX() result, or null. Both
 * snapshot reads below return exactly one row with one column. */
function latestStamp(
  rows: Array<Record<string, unknown>> | null,
): number | null {
  const value = rows?.[0]?.latest;
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * How long the ledger's capture stamp is reused within one isolate.
 *
 * The ledger is a frozen export today and a per-tick snapshot once the live
 * lane runs, so its MAX(captured_at) is the same value for every caller and
 * moves at most once per pass. Five minutes is far shorter than any plausible
 * pass and removes the query from all but the first zero-position request an
 * isolate serves.
 */
export const LEDGER_STAMP_MEMO_TTL_MS = 5 * 60 * 1000;

let ledgerStampMemo: { value: number | null; expiresAtMs: number } | null =
  null;

/** Drop the memo so the next read goes back to the lakehouse. Exported for
 * tests and for any caller that has just observed the ledger change (mirrors
 * src/decode-watermark.ts's own reset seam). */
export function resetLedgerStampMemo(): void {
  ledgerStampMemo = null;
}

registerModuleStateReset(
  "src/nominator-positions-cold-tier.ts",
  resetLedgerStampMemo,
);

/**
 * The LEDGER's own capture stamp -- not this account's. Memoized per isolate;
 * a failed read is not memoized, so a transient R2 SQL failure does not pin a
 * null for five minutes.
 */
export async function ledgerCapturedAt(
  env: Env | null | undefined,
  nowMs: number = Date.now(),
): Promise<number | null> {
  if (ledgerStampMemo && ledgerStampMemo.expiresAtMs > nowMs) {
    return ledgerStampMemo.value;
  }
  const rows = await r2SqlQuery(
    env,
    "SELECT MAX(captured_at) AS latest FROM chain.nominator_positions",
  );
  if (rows === null) return null;
  const value = latestStamp(rows);
  ledgerStampMemo = { value, expiresAtMs: nowMs + LEDGER_STAMP_MEMO_TTL_MS };
  return value;
}

/**
 * The newest StakeAdded/StakeRemoved this coldkey has on chain, or null when
 * it has none (or the read failed -- both mean "nothing here contradicts the
 * ledger", which is the conservative direction: a failed cross-check must not
 * manufacture a `degraded` label out of nothing).
 *
 * `account_events` is the LIVE stream -- the decode lane keeps writing it -- so
 * it is the one source that can tell a post-export delegator from an account
 * that genuinely holds nothing. Selective single-address predicate, which is
 * exactly the shape the request-time lakehouse lane is for.
 *
 * SANITIZES ITS OWN INPUT rather than trusting the caller. R2 SQL has no bound
 * parameters at all, so every predicate in this file is interpolated and
 * `safeSs58Literal` is the only thing standing between a request path and the
 * warehouse. This function is exported, so "the one caller already validated
 * it" is a property of today's code, not of the function -- re-validating here
 * is idempotent on an already-safe literal and costs one regex.
 */
export async function latestStakeEventAt(
  env: Env | null | undefined,
  ss58: string,
): Promise<number | null> {
  const coldkey = safeSs58Literal(ss58);
  if (coldkey === null) return null;
  const rows = await r2SqlQuery(
    env,
    "SELECT MAX(observed_at) AS latest FROM chain.account_events" +
      ` WHERE coldkey = '${coldkey}'` +
      ` AND event_kind IN ('${STAKE_ADDED_KIND}', '${STAKE_REMOVED_KIND}')`,
  );
  return latestStamp(rows);
}

/**
 * One coldkey's reconstructed nominator-side positions, or null to let the
 * caller keep its existing empty payload.
 */
export async function loadAccountPositionsColdTier(
  env: Env | null | undefined,
  ss58: string,
): Promise<ReturnType<typeof buildAccountPositions> | null> {
  // An unusable address is a decline, not an unfiltered scan of the ledger.
  const coldkey = safeSs58Literal(ss58);
  if (coldkey === null) return null;

  // One row over the cap is enough to know the cap was exceeded, and cheaper
  // than a second counting query over the same predicate.
  const rows = await r2SqlQuery(
    env,
    `SELECT ${POSITION_COLUMNS} FROM chain.nominator_positions` +
      ` WHERE coldkey = '${coldkey}' LIMIT ${POSITION_SCAN_CAP + 1}`,
  );
  if (rows === null || rows.length > POSITION_SCAN_CAP) return null;

  const stake = await neuronStakeByHotkeys(env, distinctHotkeys(rows));
  if (stake === null) return null;
  const result = buildAccountPositions(rows, stake, ss58);

  // Only a ZERO needs explaining; a result with positions already carries its
  // own stamp and is not the answer this issue is about.
  if (result.position_count > 0) return result;
  const [snapshotCapturedAtMs, latestStakeEventMs] = await Promise.all([
    ledgerCapturedAt(env),
    latestStakeEventAt(env, coldkey),
  ]);
  return annotatePositionsSnapshot(result, {
    snapshotCapturedAtMs,
    latestStakeEventMs,
  });
}
