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
import {
  buildAccountPositions,
  distinctHotkeys,
  stakeByHotkeyNetuid,
} from "./account-nominator-positions.ts";
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
async function neuronStakeByHotkeys(
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
  return buildAccountPositions(rows, stake, ss58);
}
