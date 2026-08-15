// The HOLDINGS half of the top-holders leaderboard, republished on its own
// cadence (#9632).
//
// ## What was wrong
//
// One daily cron published two things with very different natural cadences.
// `net_flow_7d/30d/90d` are 7/30/90-day windows over the lakehouse -- daily is
// genuinely right for those, and the scan costs 1.65 GB, so running it more
// often is a 79 GB/day mistake. `free_tao`/`delegated_tao`/`total_tao` are
// composed from store tables that move several times a day, and they inherited
// the flow leg's cadence for no reason except sharing a lane.
//
// Measured on the served route, the same top holder, three times:
//
//   2026-08-06   ~225 TAO behind, 3 h after a complete pass had landed
//   2026-08-09   ~321 TAO behind, 19.3 h old
//   2026-08-15   ~792 TAO behind, 6 h 10 m behind a complete pass
//
// Growing, on a public leaderboard, on the headline account.
//
// ## Why the deferral ended
//
// The cadence was left alone twice on the argument that `account_events` was
// about to move to Neon, turning the 1.65 GB `GROUP BY` into an indexed query
// and removing the cost that forced one combined pass -- so a split would be
// machinery thrown away at cutover. Checked again 2026-08-15: Neon's
// `chain_detail_account_events` holds a rolling **24.2 hours** (1,141,787 rows,
// oldest 2026-08-14T12:27Z). It has grown four-fold since the last check and is
// still a seventh of the SHORTEST window the flow legs need. The cutover is not
// close, and the error is compounding while it is waited for.
//
// ## Why this is contained, which the deferral's phrasing understated
//
// The recorded blocker was that `buildTopHoldersFlowRows` keeps the top-N per
// key across the UNION of both legs' sorts, so the retained row set depends on
// both. True -- and it does not require re-running the scan, because the flow
// leg's contribution to that union is already sitting in the published
// artifact. Re-ranking FLOW needs the scan; re-ranking HOLDINGS does not.
// `topHoldersHoldings` selects its own top-N over the FULL store tables, so a
// refresh is not a subset of a stale set -- it is the same holdings ranking a
// full run would compute, merged onto flow columns that did not move.
//
// Priced against production before it was written, per the same rule the flow
// lane's own header follows. `EXPLAIN (ANALYZE, BUFFERS)` on the real
// statement, 2026-08-15: **1,974 rows in 1.37 s, zero lakehouse bytes** --
// three sequential scans and a hash join over `account_balances` (367,462),
// `nominator_positions` (143,121) and `hotkey_alpha` (34,508). Against the
// flow scan's 7.1 s and 1.65 GB, at 8 ticks a day, this is roughly 11 seconds
// of Neon compute daily and nothing at all on the lakehouse bill.
//
// ## The one caveat, stated because it is easy to mistake for a regression
//
// The refreshed row set is the union of the flow scan's coldkeys and the
// holdings leg's own top-N. An account that belongs in the holdings top-N is
// therefore included on its own merit -- the cap is not inherited from the
// stale flow set. What IS inherited is the flow ranking itself, which is the
// point: those columns did not move, and claiming they did is the thing this
// module refuses to do (see the two stamps below).
//
// ## Failure posture
//
// It reuses runProjectionLane, so it inherits that runner's all-or-nothing
// contract verbatim: a decline leaves the published artifact exactly as it is
// and records one counted `compute_declined`. Every reason to decline below is
// a reason the CURRENT object is still the best answer available --
// specifically including "there is no artifact yet", which is the daily lane's
// job to fix and not this one's. A refresh must never be able to CREATE the
// leaderboard, only to update its store-backed half; a bug that let it would
// publish a body with no flow ranking and un-rank three sorts.

import type { ChainNetworkId } from "./chain-network.ts";
import { DEFAULT_CHAIN_NETWORK, projectionKey } from "./chain-network.ts";
import type { ProjectionLane } from "./projection-lanes.ts";
import {
  buildTopHoldersFlowRows,
  TOP_HOLDERS_FLOW_PROJECTION_KEY,
  TOP_HOLDERS_FLOW_ROW_CAP,
  TOP_HOLDERS_FLOW_SORTS,
  topHoldersFlowRows,
} from "./top-holders-flow-tier.ts";
import { topHoldersHoldings } from "./top-holders-holdings.ts";

interface ArtifactBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

/**
 * A published body's rows, projected back to the shape the row builder takes
 * as its lakehouse aggregate.
 *
 * The rename is the whole reason this exists and is not a spread:
 * `buildTopHoldersFlowRows` reads `coldkey` on the way in and writes `ss58` on
 * the way out, so feeding a written row straight back drops every one of them
 * on the `!coldkey` guard -- silently, producing a holdings-only artifact with
 * three un-ranked sorts.
 *
 * Only the flow cells are carried. The holdings cells are about to be replaced
 * wholesale, and passing the old ones through would let a column the fresh leg
 * DECLINED survive as a stale value under a fresh stamp.
 */
export function topHoldersFlowCellsFromRows(
  rows: readonly Record<string, unknown>[],
): Array<Record<string, unknown>> {
  const projected: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const ss58 = typeof row?.ss58 === "string" ? row.ss58 : null;
    if (!ss58) continue;
    const cells: Record<string, unknown> = { coldkey: ss58 };
    for (const key of TOP_HOLDERS_FLOW_SORTS) {
      if (typeof row[key] === "number") cells[key] = row[key];
    }
    projected.push(cells);
  }
  return projected;
}

/**
 * The published flow vintage -- the ISO string as written, and the epoch ms it
 * parses to -- or null when the body cannot say.
 *
 * Null is a DECLINE upstream rather than a fallback to `Date.now()`: stamping a
 * rebuilt row with the refresh clock would advance `net_flow_*`'s own age
 * without recomputing a single one of them.
 *
 * Returns the STRING as well as the number so the rewritten body can carry the
 * original forward byte-for-byte. Re-serialising a parsed instant is a
 * round-trip that has to be right for the watchdog reading it to stay right,
 * and there is no reason to take that risk on a field this lane does not own.
 */
export function publishedFlowGeneratedAt(
  body: unknown,
): { iso: string; ms: number } | null {
  const raw = (body as { generated_at?: unknown } | null)?.generated_at;
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? { iso: raw, ms } : null;
}

export interface HoldingsRefreshDeps {
  /** The store read, injectable so the merge rules can be tested without a
   * Postgres double. Defaults to the real leg. */
  holdings?: typeof topHoldersHoldings;
  /** Clock for `holdings_generated_at`. */
  now?: () => number;
}

/**
 * The refreshed artifact body, or null to leave the published one alone.
 *
 * MAINNET ONLY, for the reason the flow lane's holdings call already gives:
 * the store tables are one chain's, and pricing a testnet leaderboard from
 * them would mislabel another network's accounts. A testnet tick is a decline,
 * not a failure.
 */
export async function computeTopHoldersHoldingsRefresh(
  env: Env,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
  deps: HoldingsRefreshDeps = {},
): Promise<Record<string, unknown> | null> {
  if (network !== DEFAULT_CHAIN_NETWORK) return null;
  const bucket = (env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get) return null;

  let body: unknown;
  try {
    const object = await bucket.get(
      projectionKey(TOP_HOLDERS_FLOW_PROJECTION_KEY, network),
    );
    if (!object) return null;
    body = await object.json();
  } catch {
    return null;
  }

  // Judged by the READ PATH's own test, not a looser one. A body this refresh
  // accepted and the route rejects would be rewritten under a fresh stamp and
  // still serve an empty leaderboard -- with the watchdog now reporting it
  // healthy, because the lane is writing.
  const published = topHoldersFlowRows(body);
  if (published === null || published.length === 0) return null;
  const flow = publishedFlowGeneratedAt(body);
  if (flow === null) return null;

  const holdings = await (deps.holdings ?? topHoldersHoldings)(env);
  // Nothing proven means nothing to publish. Rewriting the artifact WITHOUT the
  // holdings columns would be a strictly worse object than the one already
  // there -- it would drop three live sorts to make a stamp move.
  if (holdings === null) return null;

  const flowCells = topHoldersFlowCellsFromRows(published);
  const shaped = buildTopHoldersFlowRows(
    flowCells,
    // THE PUBLISHED FLOW VINTAGE, not now(). Every row's `captured_at` is the
    // flow half's age and it did not change here; the holdings half carries its
    // own `holdings_captured_at`, which the merge above stamps from the input
    // passes the leg actually read.
    flow.ms,
    TOP_HOLDERS_FLOW_ROW_CAP,
    holdings,
  );
  if (shaped.length === 0) return null;

  return {
    schema_version: 1,
    // Carried forward VERBATIM. This is the sole field the flow watchdog bounds,
    // so re-deriving it from anything but the published string is a way to make
    // a dead daily lane look alive.
    generated_at: flow.iso,
    holdings_generated_at: new Date((deps.now ?? Date.now)()).toISOString(),
    row_count: shaped.length,
    sorts: [...TOP_HOLDERS_FLOW_SORTS, ...holdings.sorts],
    rows: shaped,
  };
}

/** The lane, in the shape runProjectionLane consumes. Deliberately NOT in
 * PROJECTION_LANES: those share the twice-hourly tick and read the lakehouse,
 * and this one reads neither. It writes the SAME key the flow lane writes --
 * one artifact with two writers on two cadences, which is what makes the
 * reader and every downstream consumer unchanged. */
export const TOP_HOLDERS_HOLDINGS_REFRESH_LANE: ProjectionLane = {
  name: "top-holders-holdings-refresh",
  artifactKey: TOP_HOLDERS_FLOW_PROJECTION_KEY,
  compute: computeTopHoldersHoldingsRefresh,
};
