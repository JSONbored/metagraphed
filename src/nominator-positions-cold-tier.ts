// Account-position fallbacks select the retained D1 ledger before archived SQL.
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
import { registerModuleStateReset } from "./module-state-registry.ts";
import { r2SqlQuery, safeSs58Literal } from "./r2-sql.ts";
import { readStore } from "./read-store.ts";
import { selectedD1Store } from "./d1-store.ts";
import { loadIndexedAccountFeedPage } from "./indexed-account-feeds.ts";
import type { R2SqlEnv } from "./r2-sql.ts";

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
  env: R2SqlEnv | null | undefined,
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
  env: R2SqlEnv | null | undefined,
  nowMs: number = Date.now(),
): Promise<number | null> {
  const native = await nativePositionRows(
    env,
    "SELECT MAX(captured_at) AS latest FROM nominator_positions",
  );
  if (native !== undefined) return latestStamp(native);
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
  env: R2SqlEnv | null | undefined,
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
  if (indexed !== undefined)
    return latestStamp(
      indexed === null
        ? null
        : indexed.map((row) => ({ latest: row.observed_at })),
    );
  const rows = await r2SqlQuery(
    env,
    "SELECT MAX(observed_at) AS latest FROM chain.account_events" +
      ` WHERE coldkey = '${coldkey}'` +
      ` AND event_kind IN ('${STAKE_ADDED_KIND}', '${STAKE_REMOVED_KIND}')` +
      (floorMs === null ? "" : ` AND observed_at >= ${Math.trunc(floorMs)}`),
  );
  return latestStamp(rows);
}

/**
 * One coldkey's reconstructed nominator-side positions, or null to let the
 * caller keep its existing empty payload.
 */
export async function loadAccountPositionsColdTier(
  env: R2SqlEnv | null | undefined,
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
  const rows =
    native !== undefined
      ? native
      : await r2SqlQuery(
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
