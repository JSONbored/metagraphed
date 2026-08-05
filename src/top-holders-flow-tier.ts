// The LIVE leg of GET /api/v1/accounts/top-holders: net_flow_7d/30d/90d,
// recomputed from chain.account_events on its own daily cron (#9469).
//
// WHAT THIS FIXES. The route answers from src/top-holders-artifact.ts, a
// one-shot materialization of the retired Postgres query taken 2026-08-02.
// Its `net_flow_*` cells are null for EVERY row -- the `wallet_flow_daily`
// rollup those columns were LEFT JOINed from never made it into the
// materialization -- so `compareTopHoldersSort` put every row in the
// non-number bucket and tie-broke on `ss58`. Verified live 2026-08-05:
// `?sort=net_flow_30d` returned 5C4jr9g..., 5C4stSN..., 5C4zv89..., 5C523K1...
// -- lexicographic address order -- while the envelope echoed
// `"sort": "net_flow_30d"`. A ranking that is not a ranking, announced as one.
//
// THE OTHER THREE COLUMNS ARE STILL BLOCKED, and deliberately not faked here:
//
//   free_tao   the sink landed in #9483 and is still EMPTY. That migration
//              created `account_balances` on D1 and revived the sync handler,
//              but the producer half is infra-side and human-gated: the poller
//              job still scans System::Account correctly and still writes it
//              through tokio_postgres into the decommissioned box, and its
//              vault secret has to be re-provisioned before it can POST here
//              instead. Verified against production D1, 2026-08-05: the table
//              exists, `SELECT COUNT(*)` is 0. Composing the column stays here
//              and is unblocked the day the table has rows -- the same
//              decline-while-empty switch #9292 established, applied to a leg
//              rather than a whole tier.
//   delegated  `nominator_positions` IS live, but pricing it needs each
//              (hotkey, netuid) alpha POOL total, and the only stake source in
//              D1 is `neurons.stake_tao`, which exists solely for hotkeys
//              holding a UID on that exact subnet. A delegate accrues alpha on
//              every subnet it is staked to, not just the ones it is
//              registered in: measured 2026-08-05, one coldkey's 124 positions
//              all sit on a single hotkey that `neurons` knows on 2 netuids,
//              and network-wide only 28,902 of 126,508 position rows (22.8%)
//              and 6,673 of 24,121 coldkeys (27.7%) price at all. The live
//              per-account route already reports exactly this and labels it
//              (`degraded.reason: positions_unpriceable`,
//               src/account-nominator-positions.ts). A per-row label cannot
//              rescue a RANKING, though: the same computation drops an account
//              the frozen snapshot puts at 81,185 TAO to 0 and another out of
//              the payload entirely, so a "live" delegated_tao leaderboard
//              would be confidently wrong about who the top holders are --
//              worse than the frozen one it replaced. It needs a
//              TotalHotkeyAlpha sink, which neither D1 nor the lakehouse has.
//
// So this tier answers the three sorts it can genuinely rank and DECLINES the
// other three, leaving the frozen artifact to serve them with the real numbers
// it still carries. The holdings columns come back null on a flow-sorted page
// (src/top-holders.ts) rather than zeroed -- a zero here would read as "this
// account holds nothing", which is the confident-wrong-zero this repo keeps
// removing (#9066/#9273/#9305).
//
// WHY A CRON AND NOT A REQUEST-TIME READ -- and what it costs. Priced against
// production before it was written, per #9469's own instruction. The aggregate
// is the high-cardinality shape R2 SQL rejects with 40015, so the number was
// measured rather than assumed: `GROUP BY coldkey` over the 90-day window
// scans **1.65 GB in 7.1 s** and returns 32,007 coldkeys. It does NOT trip the
// scan budget -- the 40015 case is `COUNT(DISTINCT ...)` under a GROUP BY, and
// this has neither -- so the precomputed `wallet_flow_daily`-style rollup
// #9469 anticipated is not needed. 7.1 s and 1.65 GB per request is, though:
// that is a cron, and at the shared 30-minute PROJECTION_LANES_CRON it would
// be 79 GB/day, so this lane declares its own daily cadence
// (TOP_HOLDERS_FLOW_CRON) for **1.65 GB/day**. All three windows come out of
// that ONE scan via conditional aggregation rather than three scans of the
// same files, which is where the other 2/3 of the cost went.
//
// It reuses runProjectionLane (src/projection-lanes.ts) for the write, so it
// inherits that runner's all-or-nothing posture verbatim: a declined compute
// leaves the previous artifact in place and records one exception, and a
// caller keeps yesterday's ranking rather than getting a plausible blank.

import type { ProjectionLane } from "./projection-lanes.ts";
import { PROJECTION_QUERY_TIMEOUT_MS } from "./projection-lanes.ts";
import { STAKE_ADDED_KIND, STAKE_REMOVED_KIND } from "./chain-stake-flow.ts";
import { DEFAULT_CHAIN_NETWORK, chainTable } from "./chain-network.ts";
import type { ChainNetworkId } from "./chain-network.ts";
import { r2SqlQuery } from "./r2-sql.ts";
import { buildTopHoldersList } from "./top-holders.ts";

/** Where the lane writes and the reader below gets. Under
 * `metagraph/projections/` like every other cron-recomputed card, and
 * deliberately NOT the frozen `metagraph/materialized/top-holders.json`: the
 * two artifacts answer different sorts and have different vintages, and
 * collapsing them onto one key would make the frozen holdings columns
 * unrecoverable the first time this lane ran. */
export const TOP_HOLDERS_FLOW_PROJECTION_KEY =
  "metagraph/projections/top-holders-flow.json";

/** The sort keys this tier can genuinely rank. Everything else is a decline —
 * see the header. Kept as the single source both the reader and its tests
 * read, so "which sorts are live" is stated once. */
export const TOP_HOLDERS_FLOW_SORTS = [
  "net_flow_7d",
  "net_flow_30d",
  "net_flow_90d",
];

/** Sort key -> lookback in days. The key IS the column the artifact carries,
 * so a new window is one entry here plus one entry in TOP_HOLDERS_SORTS. */
export const TOP_HOLDERS_FLOW_WINDOW_DAYS: Record<string, number> = {
  net_flow_7d: 7,
  net_flow_30d: 30,
  net_flow_90d: 90,
};

/** Matches the analytics routes' day arithmetic (src/projection-lanes.ts's
 * own DAY_MS) so a window cutoff here is the same instant the sibling
 * stake-flow lanes compute for the same label. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many rows the artifact keeps per sort key.
 *
 * One thousand, matching the frozen artifact's own union-of-top-1,000-per-key
 * shape, so both tiers hand buildTopHoldersList the same kind of prefix and
 * every `?limit=` up to the route's max of 100 is a slice of the same total
 * order. The aggregate itself returns ~32,000 coldkeys; storing all of them
 * would be a ~4 MB object to answer a 100-row page from.
 */
export const TOP_HOLDERS_FLOW_ROW_CAP = 1_000;

/**
 * The one statement, all three windows.
 *
 * Every value is a module constant or an integer computed from `nowMs` —
 * never caller input — per src/r2-sql.ts's no-bound-parameters contract.
 *
 * The outer predicate is the WIDEST window, and the narrower ones are
 * conditional sums over the same scanned rows. Three separate window queries
 * would scan the same files three times for 2.5 GB instead of 1.65 GB and
 * return three row sets to reconcile.
 */
export function topHoldersFlowSql(
  nowMs: number,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): string {
  const table = chainTable("account_events", network);
  const net = (cutoff: number) =>
    `SUM(CASE WHEN event_kind = '${STAKE_ADDED_KIND}'` +
    ` AND observed_at >= ${cutoff} THEN amount_tao ELSE 0 END)` +
    ` - SUM(CASE WHEN event_kind = '${STAKE_REMOVED_KIND}'` +
    ` AND observed_at >= ${cutoff} THEN amount_tao ELSE 0 END)`;
  const widest = nowMs - TOP_HOLDERS_FLOW_WINDOW_DAYS.net_flow_90d! * DAY_MS;
  const columns = TOP_HOLDERS_FLOW_SORTS.map(
    (key) =>
      `${net(nowMs - TOP_HOLDERS_FLOW_WINDOW_DAYS[key]! * DAY_MS)} AS ${key}`,
  ).join(", ");
  return (
    `SELECT coldkey, ${columns} FROM ${table}` +
    ` WHERE observed_at >= ${widest}` +
    ` AND event_kind IN ('${STAKE_ADDED_KIND}', '${STAKE_REMOVED_KIND}')` +
    ` AND coldkey IS NOT NULL GROUP BY coldkey`
  );
}

/** A finite flow cell, or null. Signed on purpose: a net outflow is a real
 * negative, and only a non-finite/absent cell is missing data. */
function nullableFlow(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The aggregate rows shaped into the artifact's `rows` array: the union of the
 * top TOP_HOLDERS_FLOW_ROW_CAP coldkeys per sort key.
 *
 * A row is kept only if at least one window has a readable number — a coldkey
 * whose every cell is unreadable ranks on nothing and would only pad the
 * artifact. Holdings columns are ABSENT rather than zeroed; buildTopHoldersEntry
 * turns an absent cell into null, which is what a flow-sorted page should say
 * about a column this tier cannot see.
 *
 * Pure, so the union rule is testable without a lakehouse or a bucket.
 */
export function buildTopHoldersFlowRows(
  aggregateRows: Array<Record<string, unknown>> | null | undefined,
  generatedAtMs: number,
  cap: number = TOP_HOLDERS_FLOW_ROW_CAP,
): Array<Record<string, unknown>> {
  const byColdkey = new Map<string, Record<string, unknown>>();
  for (const row of Array.isArray(aggregateRows) ? aggregateRows : []) {
    const coldkey = typeof row?.coldkey === "string" ? row.coldkey : null;
    if (!coldkey || coldkey.length === 0) continue;
    const flows = TOP_HOLDERS_FLOW_SORTS.map(
      (key) => [key, nullableFlow(row[key])] as const,
    );
    if (flows.every(([, value]) => value === null)) continue;
    byColdkey.set(coldkey, {
      ss58: coldkey,
      ...Object.fromEntries(flows),
      // The LANE's stamp, not the account's newest event: it is what makes the
      // envelope's captured_at advance, and it is the honest answer to "how
      // old is this ranking" for every row alike.
      captured_at: generatedAtMs,
    });
  }

  const candidates = [...byColdkey.values()];
  const kept = new Map<string, Record<string, unknown>>();
  for (const key of TOP_HOLDERS_FLOW_SORTS) {
    const ranked = candidates
      .filter((row) => typeof row[key] === "number")
      .sort(
        (a, b) =>
          (b[key] as number) - (a[key] as number) ||
          (a.ss58 as string).localeCompare(b.ss58 as string),
      )
      .slice(0, cap);
    for (const row of ranked) kept.set(row.ss58 as string, row);
  }
  // Address order, so the object is byte-stable between two runs that ranked
  // the same accounts — the reader re-sorts by the requested key anyway.
  return [...kept.values()].sort((a, b) =>
    (a.ss58 as string).localeCompare(b.ss58 as string),
  );
}

/**
 * The artifact body, or null when the lakehouse could not answer — which
 * leaves the previous day's ranking in place rather than replacing it with an
 * empty one (runProjectionLane's contract).
 */
export async function computeTopHoldersFlow(
  env: Env,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Record<string, unknown> | null> {
  const generatedAt = Date.now();
  const rows = await r2SqlQuery(env, topHoldersFlowSql(generatedAt, network), {
    timeoutMs: PROJECTION_QUERY_TIMEOUT_MS,
  });
  if (rows === null) return null;
  const shaped = buildTopHoldersFlowRows(rows, generatedAt);
  return {
    // Deliberately the SAME shape src/top-holders-artifact.ts reads, so the
    // reader below is the frozen reader's twin rather than a second dialect.
    schema_version: 1,
    generated_at: new Date(generatedAt).toISOString(),
    row_count: shaped.length,
    rows: shaped,
  };
}

/** The lane, in the shape runProjectionLane consumes. NOT registered in
 * PROJECTION_LANES: those all share the 30-minute cron and the staleness
 * bound derived from it, and an 8-missed-tick (4 h) bound over a daily
 * producer is the alarm-that-always-fires #9301 corrected elsewhere. It gets
 * its own cron branch and its own watchdog entry instead. */
export const TOP_HOLDERS_FLOW_LANE: ProjectionLane = {
  name: "top-holders-flow",
  artifactKey: TOP_HOLDERS_FLOW_PROJECTION_KEY,
  compute: computeTopHoldersFlow,
};

interface ArtifactBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

/**
 * The rows this reader will serve, or null when the body is not the artifact
 * the lane wrote.
 *
 * Same test as topHoldersArtifactRows, and exported for the same reason: the
 * watchdog must judge the object by the test the read path applies, or it
 * reports healthy on exactly the object the route is declining to serve.
 */
export function topHoldersFlowRows(
  body: unknown,
): Record<string, unknown>[] | null {
  const parsed = body as { schema_version?: unknown; rows?: unknown } | null;
  if (parsed?.schema_version !== 1 || !Array.isArray(parsed.rows)) return null;
  return parsed.rows as Record<string, unknown>[];
}

/**
 * The live flow leaderboard for a `net_flow_*` sort, or null to fall through
 * to the frozen artifact.
 *
 * DECLINES ON A SORT IT CANNOT RANK, which is the whole reason this returns
 * null rather than an empty page: `?sort=total_tao` over flow-only rows would
 * put every row in compareTopHoldersSort's non-number bucket and answer in
 * address order — reproducing, for the holdings columns, the exact defect this
 * module exists to remove.
 */
export async function loadTopHoldersFlowTier(
  env: Env | null | undefined,
  query: { sort?: string; limit?: unknown },
): Promise<ReturnType<typeof buildTopHoldersList> | null> {
  if (!TOP_HOLDERS_FLOW_SORTS.includes(query.sort ?? "")) return null;
  const bucket = (env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get) return null;
  try {
    const object = await bucket.get(TOP_HOLDERS_FLOW_PROJECTION_KEY);
    if (!object) return null;
    const rows = topHoldersFlowRows(await object.json());
    // An artifact with no rows is a decline, not an answer: the frozen
    // leaderboard is still a better response than an empty one, and this is
    // the pre-first-run state as well as the emptied-in-place fault.
    if (rows === null || rows.length === 0) return null;
    return buildTopHoldersList(rows, {
      sort: query.sort,
      limit: query.limit,
    });
  } catch {
    return null;
  }
}
