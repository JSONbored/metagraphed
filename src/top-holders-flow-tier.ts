// Top-holder flows come from qualified native analytics facts. Holdings join
// the complete coldkey population on their own D1 refresh cadence; each leg
// retains its own capture timestamp and supported ranking keys.

import { artifactBucket } from "./projection-store.ts";

import type { ProjectionLane } from "./projection-lanes.ts";
import { STAKE_ADDED_KIND, STAKE_REMOVED_KIND } from "./chain-stake-flow.ts";
import { DEFAULT_CHAIN_NETWORK, chainTable } from "./chain-network.ts";
import type { ChainNetworkId } from "./chain-network.ts";
import { loadNativeTopHoldersFlow } from "./top-holders-native-flow.ts";
import { buildTopHoldersList } from "./top-holders.ts";
import {
  TOP_HOLDERS_DELEGATED_SORT,
  TOP_HOLDERS_FREE_SORT,
  TOP_HOLDERS_TOTAL_SORT,
  topHoldersHoldings,
  type HoldingsLeg,
} from "./top-holders-holdings.ts";
/** Where the lane writes and the reader below gets. Under
 * `metagraph/projections/` like every other cron-recomputed card, and
 * deliberately NOT the frozen `metagraph/materialized/top-holders.json`: the
 * two artifacts answer different sorts and have different vintages, and
 * collapsing them onto one key would make the frozen holdings columns
 * unrecoverable the first time this lane ran. */
export const TOP_HOLDERS_FLOW_PROJECTION_KEY =
  "metagraph/projections/top-holders-flow.json";

/** The sort keys the FLOW leg can rank. Everything else is a decline — see the
 * header. Kept as the single source both the lane and its tests read, so
 * "which sorts does the lakehouse leg back" is stated once. */
export const TOP_HOLDERS_FLOW_SORTS = [
  "net_flow_7d",
  "net_flow_30d",
  "net_flow_90d",
];

/**
 * The sort keys the HOLDINGS leg can back, when its inputs are proven.
 *
 * Separate from the list above because the two legs fail independently, and
 * separate from src/top-holders-holdings.ts's own per-column constants because
 * this is the ORDER the artifact declares them in. Which sorts an artifact
 * actually backs is a property of the WRITTEN artifact, not of this module --
 * see `sorts` in the body the lane emits.
 */
export const TOP_HOLDERS_HOLDINGS_SORTS = [
  TOP_HOLDERS_FREE_SORT,
  TOP_HOLDERS_DELEGATED_SORT,
  TOP_HOLDERS_TOTAL_SORT,
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
 * never caller input — per src/history-readers.ts's no-bound-parameters contract.
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
  /** The proven holdings columns, or null when that leg declined entirely.
   * The leg carries its OWN `sorts` rather than a fixed three, because its
   * inputs become provable on different days: `free_tao` needs a complete
   * `account_balances` pass, `delegated_tao` a complete `hotkey_alpha` one, and
   * `total_tao` both. Only the sorts it reports are ranked below. */
  holdings: HoldingsLeg | null = null,
): Array<Record<string, unknown>> {
  const byColdkey = new Map<string, Record<string, unknown>>();
  const add = (ss58: string, cells: Record<string, unknown>) => {
    const existing = byColdkey.get(ss58);
    if (existing) Object.assign(existing, cells);
    else byColdkey.set(ss58, { ss58, ...cells, captured_at: generatedAtMs });
  };

  for (const row of Array.isArray(aggregateRows) ? aggregateRows : []) {
    const coldkey = typeof row?.coldkey === "string" ? row.coldkey : null;
    if (!coldkey || coldkey.length === 0) continue;
    const flows = TOP_HOLDERS_FLOW_SORTS.map(
      (key) => [key, nullableFlow(row[key])] as const,
    );
    if (flows.every(([, value]) => value === null)) continue;
    // The LANE's stamp, not the account's newest event: it is what makes the
    // envelope's captured_at advance, and it is the honest answer to "how old
    // is this ranking" for every row alike.
    add(coldkey, Object.fromEntries(flows));
  }
  for (const [ss58, cells] of holdings?.cells ?? []) {
    // HoldingsCells names its three optional keys rather than carrying an index
    // signature, which is the stricter and more useful shape everywhere else;
    // `add` takes the open record every other caller hands it.
    //
    // STAMPED SEPARATELY FROM `captured_at`, because after #9632 the two halves
    // of a row have genuinely different vintages: the flow cells are as old as
    // the daily lakehouse scan and the holdings cells as old as their last
    // store refresh, which is hours fresher. One stamp could only be a lie
    // about one of them. A row the holdings leg never named carries no
    // `holdings_captured_at` at all -- absent, not zero, the same rule its
    // cells follow.
    add(ss58, {
      ...(cells as Record<string, unknown>),
      holdings_captured_at: holdings?.capturedAt,
    });
  }

  const candidates = [...byColdkey.values()];
  const rankedKeys = [...TOP_HOLDERS_FLOW_SORTS, ...(holdings?.sorts ?? [])];
  const kept = new Map<string, Record<string, unknown>>();
  for (const key of rankedKeys) {
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
  const now = Date.now();
  const native = await loadNativeTopHoldersFlow(env, network, now);
  if (native == null) return null;
  const generatedAt = native.generatedAt;
  const rows = native.rows;
  // The HOLDINGS leg is optional and store-backed, so it is mainnet-only -- the
  // testnet projection has no balance ledger or pool ledger of its own, and
  // reading the mainnet ones for it would mislabel another chain's accounts.
  const holdings =
    network === DEFAULT_CHAIN_NETWORK ? await topHoldersHoldings(env) : null;
  const shaped = buildTopHoldersFlowRows(
    rows,
    generatedAt,
    TOP_HOLDERS_FLOW_ROW_CAP,
    holdings,
  );
  return {
    // Deliberately the SAME shape src/top-holders-artifact.ts reads, so the
    // reader below is the frozen reader's twin rather than a second dialect.
    schema_version: 1,
    generated_at: new Date(generatedAt).toISOString(),
    // WHEN THE HOLDINGS HALF LAST RAN, which after #9632 is not the same tick:
    // src/top-holders-holdings-refresh.ts rewrites these columns every three
    // hours over the row set this scan produced. Written here too -- by the
    // daily lane, which refreshes both halves at once -- so the field is
    // present on every body a live lane wrote and its ABSENCE means the lane
    // that wrote this predates the split.
    //
    // The LANE CLOCK, deliberately, unlike the per-row `holdings_captured_at`
    // beside it: this one answers "is the refresh lane alive" for
    // src/top-holders-staleness-watchdog.ts, and that question must not be
    // answerable by a producer that stopped. The data's own age is the row
    // stamp.
    ...(holdings ? { holdings_generated_at: new Date(now).toISOString() } : {}),
    row_count: shaped.length,
    // WHICH SORTS THIS BODY CAN RANK, declared by the writer rather than
    // assumed by the reader. The legs fail independently and each holdings
    // column becomes provable on its own day, so "is delegated_tao live" is a
    // fact about the object that actually got written -- and stating it here is
    // what lets a ledger start backing its sort with no deploy and no flag.
    // The holdings leg reports its OWN sorts rather than a fixed three.
    sorts: [...TOP_HOLDERS_FLOW_SORTS, ...(holdings?.sorts ?? [])],
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

/** Every sort ANY version of this artifact could back -- the union of both
 * legs. Used only for the pre-fetch rejection; the authority on a given body
 * is that body's own `sorts`. */
export const TOP_HOLDERS_LIVE_SORTS = [
  ...TOP_HOLDERS_FLOW_SORTS,
  ...TOP_HOLDERS_HOLDINGS_SORTS,
];

/**
 * The sorts a written body says it ranked, intersected with the ones this
 * module recognises.
 *
 * A body with no `sorts` is one the flow-only lane wrote (#9492), and is read
 * as flow-only -- so a deploy that lands this code before the next 01:34 tick
 * keeps answering exactly what it answered yesterday, rather than declining
 * every sort for a day or claiming a `free_tao` column that object does not
 * carry. Unrecognised entries are dropped rather than trusted: the artifact
 * is ours, but a reader that ranks on whatever a stored string asks for is
 * one bad write away from a confident nonsense ordering.
 */
export function topHoldersArtifactSorts(body: unknown): string[] {
  const declared = (body as { sorts?: unknown } | null)?.sorts;
  if (!Array.isArray(declared)) return TOP_HOLDERS_FLOW_SORTS;
  return declared.filter(
    (entry): entry is string =>
      typeof entry === "string" && TOP_HOLDERS_LIVE_SORTS.includes(entry),
  );
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
  // Cheap rejection BEFORE the R2 round trip for the sorts no version of this
  // artifact can ever back. The finer per-body check is below, once the
  // written object can say what it actually ranked.
  const sort = query.sort ?? "";
  if (!TOP_HOLDERS_LIVE_SORTS.includes(sort)) return null;
  const bucket = artifactBucket(env);
  if (!bucket) return null;
  try {
    const object = await bucket.get(TOP_HOLDERS_FLOW_PROJECTION_KEY);
    if (!object) return null;
    const body = await object.json();
    const rows = topHoldersFlowRows(body);
    // An artifact with no rows is a decline, not an answer: the frozen
    // leaderboard is still a better response than an empty one, and this is
    // the pre-first-run state as well as the emptied-in-place fault.
    if (rows === null || rows.length === 0) return null;
    if (!topHoldersArtifactSorts(body).includes(sort)) return null;
    return buildTopHoldersList(rows, {
      sort,
      limit: query.limit,
    });
  } catch {
    return null;
  }
}
