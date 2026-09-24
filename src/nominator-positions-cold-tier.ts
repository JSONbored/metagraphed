// Account positions use the selected D1 ledger and indexed activity history.
// Live neuron stakes price every position; selected owner failures decline
// without replacing a current answer with a stale archive. Complete native
// account feeds provide the stake-activity cross-check for a zero snapshot.
import {
  annotatePositionsSnapshot,
  buildAccountPositions,
  distinctHotkeys,
  stakeByHotkeyNetuid,
} from "./account-nominator-positions.ts";
import { accountHistoryFloorMs } from "./account-summary-projection.ts";
import { STAKE_ADDED_KIND, STAKE_REMOVED_KIND } from "./account-stake-flow.ts";
import { safeSs58Literal } from "./history-readers.ts";
import { readStore } from "./read-store.ts";
import { selectedD1Store } from "./d1-store.ts";
import { loadIndexedAccountFeedPage } from "./indexed-account-feeds.ts";
import type { HistoryReadEnv } from "./history-readers.ts";

async function nativePositionRows(
  env: unknown,
  text: string,
  values: unknown[] = [],
): Promise<Record<string, unknown>[] | null | undefined> {
  try {
    const store = selectedD1Store(env, ["nominator_positions"]);
    return store ? await store.query(text, values) : undefined;
  } catch {
    return null;
  }
}

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
 * Hotkey IN-lists are chunked at this many bound parameters per statement.
 *
 * The number is inherited from D1, whose platform cap this was; Postgres
 * takes 65,535 binds so it no longer REJECTS anything. It stays because the
 * chunked shape is what the tests pin and a bounded statement is the safer
 * default -- a tuning knob now, not a ceiling (#10228).
 */
export const BIND_PARAM_CHUNK = 100;

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
  env: HistoryReadEnv | null | undefined,
  hotkeys: string[],
): Promise<Map<string, number> | null> {
  if (hotkeys.length === 0) return new Map();
  const db = readStore(env, ["neurons"]);
  if (!db?.query) return null;
  const chunks: string[][] = [];
  for (let i = 0; i < hotkeys.length; i += BIND_PARAM_CHUNK) {
    chunks.push(hotkeys.slice(i, i + BIND_PARAM_CHUNK));
  }
  let results: unknown[][];
  try {
    results = await Promise.all(
      chunks.map(async (chunk) => {
        const placeholders = chunk.map(() => "?").join(", ");
        return await db.query!(
          `SELECT hotkey, netuid, stake_tao FROM neurons WHERE hotkey IN (${placeholders})`,
          chunk,
        );
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

/** The selected ledger supplies its own current capture timestamp. */
export async function ledgerCapturedAt(
  env: HistoryReadEnv | null | undefined,
): Promise<number | null> {
  const native = await nativePositionRows(
    env,
    "SELECT MAX(captured_at) AS latest FROM nominator_positions",
  );
  return latestStamp(native ?? null);
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
 * Validate the exported reader independently so malformed addresses cannot
 * broaden the native index traversal.
 */
export async function latestStakeEventAt(
  env: HistoryReadEnv | null | undefined,
  ss58: string,
): Promise<number | null> {
  const coldkey = safeSs58Literal(ss58);
  if (coldkey === null) return null;
  // FLOORED, and it had no bound at all. `MAX(observed_at)` over a scattered
  // `coldkey` reads this account's whole history, and it fires precisely for
  // the accounts holding NO delegated positions -- so the cheapest answer paid
  // the most expensive read. The scan-bound gate could not see it either: its
  // PRUNABLE test is bare substring presence, and `MAX(observed_at)` in the
  // SELECT list satisfied it without a single predicate on that column.
  //
  // Same table the projection describes, so the floor is sound here in a way it
  // is NOT for chain.extrinsics -- see loadAccountExtrinsicsColdTier.
  const floorMs = await accountHistoryFloorMs(env, ss58);
  const indexed = await loadIndexedAccountFeedPage(
    env,
    [STAKE_ADDED_KIND, STAKE_REMOVED_KIND].map((kind) => ({
      side: "coldkey",
      account: coldkey,
      kind,
      observedStart: floorMs ?? undefined,
    })),
    1,
  );
  return latestStamp(
    indexed == null
      ? null
      : indexed.map((row) => ({ latest: row.observed_at })),
  );
}

/**
 * One coldkey's reconstructed nominator-side positions, or null to let the
 * caller keep its existing empty payload.
 */
export async function loadAccountPositionsColdTier(
  env: HistoryReadEnv | null | undefined,
  ss58: string,
): Promise<ReturnType<typeof buildAccountPositions> | null> {
  // An unusable address is a decline, not an unfiltered scan of the ledger.
  const coldkey = safeSs58Literal(ss58);
  if (coldkey === null) return null;

  // One row over the cap is enough to know the cap was exceeded, and cheaper
  // than a second counting query over the same predicate.
  const native = await nativePositionRows(
    env,
    `SELECT ${POSITION_COLUMNS} FROM nominator_positions WHERE coldkey = ? LIMIT ?`,
    [coldkey, POSITION_SCAN_CAP + 1],
  );
  const rows = native;
  if (rows == null || rows.length > POSITION_SCAN_CAP) return null;

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
