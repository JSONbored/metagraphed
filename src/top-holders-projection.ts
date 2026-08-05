// The top-holders recompute lane (#9469).
//
// GET /api/v1/accounts/top-holders has answered from a one-shot
// pre-decommission materialization since the box died (#9464): a fixed
// `captured_at`, three permanently-null net-flow columns, and a holder list
// that ages without changing. #9483 gave `free_tao` a D1 sink again; this lane
// is the other half -- it recomputes the whole artifact from the live stores,
// so every column the route publishes has a producer behind it.
//
// WHERE EACH COLUMN COMES FROM, and why this lane is the first hybrid one:
//
//   free_tao       D1 `account_balances` -- a System::Account state scan. NOT
//                  derivable from the lakehouse at any price: the lakehouse
//                  holds EVENTS, and reconstructing a balance from transfer/
//                  fee/stake replay is exactly the drift the state scan exists
//                  to avoid (0017's own header).
//   delegated_tao  D1 `nominator_positions` x `neurons` x `subnet_snapshots`
//                  -- the same share_fraction x stake_tao x alpha_price_tao
//                  computation /accounts/{ss58}/positions already does per
//                  account (#8803), aggregated across every account here.
//   net_flow_*     The lakehouse `account_events` StakeAdded/StakeRemoved
//                  stream. `wallet_flow_daily`, the rollup the original query
//                  read, exists only in prose now -- its cron was retired with
//                  the box (#9193) and no table of that name was ever created
//                  on D1.
//
// Every other lane in PROJECTION_LANES reads R2 SQL alone. This one reads D1
// too, because two of its three inputs are chain STATE rather than an event
// stream, and state does not live in the lakehouse.
//
// ## Why it declines instead of publishing a partial answer
//
// `account_balances` is filled by a poller job that has to be redeployed
// before it writes anything. Until it does, the table is empty -- and a
// leaderboard computed from an empty balance table is not "missing a column",
// it is WRONG: `free_tao` dominates `total_tao` for exactly the accounts a
// top-holder list is about, so publishing zeros would reorder the ranking and
// drop real whales off it entirely. The frozen artifact, for all its faults,
// carries genuine 2026-08-02 balances.
//
// So `computeTopHolders` returns null while the balance tier is cold, the
// runner writes nothing (its all-or-nothing contract), and the reader keeps
// serving the frozen copy. The moment the poller lands rows this lane starts
// publishing on its own -- no flag, no second deploy, no code change.

import {
  DEFAULT_CHAIN_NETWORK,
  chainTable,
  type ChainNetworkId,
} from "./chain-network.ts";
import { r2SqlQuery } from "./r2-sql.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";
import { STAKE_ADDED_KIND, STAKE_REMOVED_KIND } from "./chain-stake-flow.ts";
import { TOP_HOLDERS_ARTIFACT_KEY } from "./top-holders-artifact.ts";

export { TOP_HOLDERS_ARTIFACT_KEY };

type Row = Record<string, unknown>;

/**
 * How many rows the artifact carries per sortable key.
 *
 * The route serves at most 100 (TOP_HOLDERS_LIMIT_MAX), so 1,000 is ten pages
 * of headroom and matches what the frozen artifact already held -- its header
 * describes exactly this "union of the top 1,000 rows per sortable key" shape,
 * and keeping it means the reader's slice behaviour is unchanged.
 */
export const TOP_HOLDERS_PROJECTION_ROW_LIMIT = 1_000;

/** The windows the route publishes, in days. */
export const TOP_HOLDERS_NET_FLOW_WINDOWS = [7, 30, 90] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** An SS58 safe to inline as a SQL literal, or null. The candidate set is
 * built from values this Worker just read out of its own stores, but they are
 * still concatenated into SQL, so the check is on the way IN rather than
 * assumed from provenance. */
export function safeSs58(value: unknown): string | null {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{2,64}$/.test(value)
    ? value
    : null;
}

function finiteNonNegative(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function finiteOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface TopHoldersProjectionInputs {
  /** ss58 -> {free_tao, captured_at} from D1 account_balances. */
  balances: Map<string, { freeTao: number; capturedAt: number }>;
  /** coldkey -> delegated TAO from the D1 positions join. */
  delegated: Map<string, number>;
  /** coldkey -> {7: n, 30: n, 90: n} from the lakehouse. Absent windows stay
   * null, which is the published contract: "no flow row in the window" is a
   * different claim from "confirmed zero movement". */
  netFlow: Map<string, Partial<Record<number, number>>>;
}

/**
 * Shape the three live inputs into the artifact's `rows`, exactly as
 * `buildTopHoldersList` expects to receive them.
 *
 * Pure, so the union semantics are testable without a database or a lakehouse.
 * An account present in ANY input appears, matching the original FULL OUTER
 * JOIN -- a coldkey with only delegated stake is a real holder, and so is one
 * that only moved stake this week.
 */
export function buildTopHoldersProjectionRows(
  inputs: TopHoldersProjectionInputs,
): Row[] {
  const { balances, delegated, netFlow } = inputs;
  const accounts = new Set<string>([
    ...balances.keys(),
    ...delegated.keys(),
    ...netFlow.keys(),
  ]);
  const rows: Row[] = [];
  for (const ss58 of accounts) {
    const balance = balances.get(ss58);
    const flows = netFlow.get(ss58);
    rows.push({
      ss58,
      free_tao: balance?.freeTao ?? 0,
      delegated_tao: delegated.get(ss58) ?? 0,
      net_flow_7d: flows?.[7] ?? null,
      net_flow_30d: flows?.[30] ?? null,
      net_flow_90d: flows?.[90] ?? null,
      // The route reports the freshest `captured_at` across its rows as the
      // leaderboard's own stamp, so this must be the BALANCE capture -- the
      // only one of the three inputs that is a point-in-time state read.
      captured_at: balance?.capturedAt ?? null,
    });
  }
  // Deterministic order so an unchanged input produces an unchanged artifact
  // (the reader re-sorts per request anyway; this is for diffability).
  rows.sort(
    (a, b) =>
      Number(b.free_tao) +
        Number(b.delegated_tao) -
        (Number(a.free_tao) + Number(a.delegated_tao)) ||
      String(a.ss58).localeCompare(String(b.ss58)),
  );
  return rows;
}

/** The D1 surface this lane needs, so a test can inject a fake. */
export type D1Runner = (
  sql: string,
  params?: unknown[],
) => Promise<Row[] | null>;

/**
 * Top holdings straight from D1, free and delegated together.
 *
 * ONE query rather than two lists stitched in the Worker: ranking by
 * `free_tao + delegated_tao` is the route's default sort, and doing the join
 * in SQL is what makes each returned row carry BOTH columns exactly. Stitching
 * two independent top-N lists would leave an account that made one list but
 * not the other reading zero for the column it missed -- an understatement
 * that looks like data.
 *
 * The delegated side mirrors buildAccountPositions' valuation (#8803):
 * share_fraction x the hotkey's stake_tao x that netuid's latest
 * alpha_price_tao. An unpriced netuid contributes zero, which IS the published
 * "excluded from the sum rather than counted as zero" -- excluding a term from
 * a sum and adding zero are the same operation. netuid 0 never appears: the
 * poller skips root, whose Alpha entries are all zero by construction.
 */
export async function loadTopHoldings(
  d1: D1Runner,
  limit: number,
): Promise<Row[] | null> {
  return d1(
    `SELECT ab.ss58 AS ss58, ab.free_tao AS free_tao,
            ab.captured_at AS captured_at,
            COALESCE(d.delegated_tao, 0) AS delegated_tao
       FROM account_balances ab
       LEFT JOIN (
         SELECT np.coldkey AS coldkey,
                SUM(np.share_fraction * n.stake_tao
                    * COALESCE(p.alpha_price_tao, 0)) AS delegated_tao
           FROM nominator_positions np
           JOIN neurons n
             ON n.hotkey = np.hotkey AND n.netuid = np.netuid
           LEFT JOIN (
             SELECT s.netuid AS netuid, s.alpha_price_tao AS alpha_price_tao
               FROM subnet_snapshots s
               JOIN (SELECT netuid, MAX(snapshot_date) AS snapshot_date
                       FROM subnet_snapshots GROUP BY netuid) latest
                 ON latest.netuid = s.netuid
                AND latest.snapshot_date = s.snapshot_date
           ) p ON p.netuid = np.netuid
          GROUP BY np.coldkey
       ) d ON d.coldkey = ab.ss58
      ORDER BY (ab.free_tao + COALESCE(d.delegated_tao, 0)) DESC
      LIMIT ?`,
    [limit],
  );
}

/**
 * Coldkeys whose only claim on the leaderboard is delegated stake.
 *
 * The join above is anchored on `account_balances`, so an account that has
 * never held a free balance cannot appear in it -- and such an account is a
 * real holder the original FULL OUTER JOIN included. This is that half of the
 * outer join, as its own query because SQLite's FULL OUTER JOIN support is not
 * something to depend on across D1 versions for a lane that must not fail.
 */
export async function loadDelegatedOnlyHolders(
  d1: D1Runner,
  limit: number,
): Promise<Row[] | null> {
  return d1(
    `SELECT np.coldkey AS ss58,
            SUM(np.share_fraction * n.stake_tao
                * COALESCE(p.alpha_price_tao, 0)) AS delegated_tao
       FROM nominator_positions np
       JOIN neurons n ON n.hotkey = np.hotkey AND n.netuid = np.netuid
       LEFT JOIN (
         SELECT s.netuid AS netuid, s.alpha_price_tao AS alpha_price_tao
           FROM subnet_snapshots s
           JOIN (SELECT netuid, MAX(snapshot_date) AS snapshot_date
                   FROM subnet_snapshots GROUP BY netuid) latest
             ON latest.netuid = s.netuid
            AND latest.snapshot_date = s.snapshot_date
       ) p ON p.netuid = np.netuid
      GROUP BY np.coldkey
      ORDER BY delegated_tao DESC
      LIMIT ?`,
    [limit],
  );
}

/**
 * Net stake flow per coldkey for all three windows, from ONE lakehouse scan.
 *
 * Conditional aggregation over a single 90-day pass rather than three
 * separately-windowed queries: R2 SQL is priced by what a statement scans
 * (src/r2-sql.ts), so scanning the widest window once and folding the two
 * narrower ones out of it costs a third of the obvious shape. The CASE form
 * over `event_kind`/`amount_tao` is the one src/account-feeds-cold-tier.ts
 * already runs against this table.
 *
 * Ordered by the 90-day magnitude so the row budget spends itself on the
 * accounts that actually moved stake, and a null is preserved as null: an
 * account with no row in a window has no flow to report, which the route
 * publishes as `null` and sorts last -- explicitly NOT zero.
 */
export async function loadNetFlowByColdkey(
  env: Env,
  network: ChainNetworkId,
  nowMs: number,
  limit: number,
): Promise<Row[] | null> {
  const cutoff = (days: number) => nowMs - days * DAY_MS;
  const net = (days: number) =>
    `SUM(CASE WHEN observed_at >= ${cutoff(days)} AND event_kind = '${STAKE_ADDED_KIND}' THEN amount_tao ` +
    `WHEN observed_at >= ${cutoff(days)} AND event_kind = '${STAKE_REMOVED_KIND}' THEN -amount_tao ` +
    `ELSE 0 END)`;
  return r2SqlQuery(
    env,
    `SELECT coldkey,` +
      ` ${net(7)} AS net_flow_7d,` +
      ` ${net(30)} AS net_flow_30d,` +
      ` ${net(90)} AS net_flow_90d` +
      ` FROM ${chainTable("account_events", network)}` +
      ` WHERE event_kind IN ('${STAKE_ADDED_KIND}', '${STAKE_REMOVED_KIND}')` +
      ` AND observed_at >= ${cutoff(90)} AND coldkey IS NOT NULL` +
      ` GROUP BY coldkey` +
      ` ORDER BY ABS(${net(90)}) DESC` +
      ` LIMIT ${limit}`,
  );
}

/** Fill exact holdings for accounts that reached the artifact on net flow
 * alone. One query with inlined, validated literals rather than a bound-param
 * batch: D1's Workers binding caps parameters at 100, and this set is up to
 * TOP_HOLDERS_PROJECTION_ROW_LIMIT wide. */
export async function loadHoldingsForAccounts(
  d1: D1Runner,
  ss58s: string[],
): Promise<Row[] | null> {
  const safe = ss58s.map(safeSs58).filter((v): v is string => v !== null);
  if (!safe.length) return [];
  const list = safe.map((s) => `'${s}'`).join(",");
  return d1(
    `SELECT ss58, free_tao, captured_at FROM account_balances
      WHERE ss58 IN (${list})`,
    [],
  );
}

export interface TopHoldersComputeDeps {
  now?: () => number;
  /** Injectable D1 runner, so the lane is testable without a database. */
  d1?: D1Runner;
}

function d1RunnerFor(env: Env): D1Runner | null {
  const db = (env as unknown as { METAGRAPH_HEALTH_DB?: unknown })
    .METAGRAPH_HEALTH_DB as
    | {
        prepare(sql: string): {
          bind(...p: unknown[]): { all(): Promise<{ results?: Row[] }> };
          all(): Promise<{ results?: Row[] }>;
        };
      }
    | undefined;
  if (!db?.prepare) return null;
  return async (sql, params = []) => {
    try {
      const stmt = db.prepare(sql);
      const result = params.length
        ? await stmt.bind(...params).all()
        : await stmt.all();
      return result?.results ?? [];
    } catch {
      // A failed read declines the whole lane rather than contributing an
      // empty column -- see the module header's all-or-nothing posture.
      return null;
    }
  };
}

/**
 * The lane body: the whole leaderboard, recomputed, or null.
 *
 * Null on ANY of: a non-mainnet tick (the D1 tiers this reads are mainnet-only
 * — there is no testnet `account_balances`), an unbound D1, a failed read, or
 * a cold balance tier. Each of those would otherwise publish a leaderboard
 * that is confidently wrong rather than merely stale.
 */
export async function computeTopHolders(
  env: Env,
  network: ChainNetworkId,
  deps: TopHoldersComputeDeps = {},
): Promise<Record<string, unknown> | null> {
  // Mainnet-only BY CONSTRUCTION, not by policy: `account_balances`,
  // `nominator_positions` and `subnet_snapshots` are single mainnet D1 tables
  // with no network column, so a testnet tick would read mainnet holdings and
  // publish them under a testnet key.
  if (network !== DEFAULT_CHAIN_NETWORK) return null;

  const now = deps.now ?? Date.now;
  const d1 = deps.d1 ?? d1RunnerFor(env);
  if (!d1) return null;

  const limit = TOP_HOLDERS_PROJECTION_ROW_LIMIT;
  const holdings = await loadTopHoldings(d1, limit);
  // A cold balance tier is the expected state until the poller redeploys, and
  // it is a DECLINE rather than an empty artifact: see the module header.
  if (holdings === null || holdings.length === 0) return null;

  const [delegatedOnly, netFlowRows] = await Promise.all([
    loadDelegatedOnlyHolders(d1, limit),
    loadNetFlowByColdkey(env, network, now(), limit),
  ]);
  // Holdings are all-or-nothing: without them there is no leaderboard.
  if (delegatedOnly === null) return null;
  // NET FLOW IS NOT. It is a secondary sort key, it is null for every account
  // in the artifact this replaces, and null already has a published meaning
  // ("no flow row for this account in the window"). Declining the whole
  // leaderboard -- and so leaving free_tao stale for another six hours --
  // because a secondary column could not be read would be the worse trade.
  // The degradation is reported rather than hidden: the runner raises one
  // exception on `net_flow_available: false`, so a lakehouse that stops
  // answering does not quietly become "nobody moved any stake".
  const netFlowAvailable = netFlowRows !== null;

  const balances = new Map<string, { freeTao: number; capturedAt: number }>();
  const delegated = new Map<string, number>();
  for (const row of holdings) {
    const ss58 = safeSs58(row.ss58);
    if (!ss58) continue;
    balances.set(ss58, {
      freeTao: finiteNonNegative(row.free_tao),
      capturedAt: finiteNonNegative(row.captured_at),
    });
    delegated.set(ss58, finiteNonNegative(row.delegated_tao));
  }
  for (const row of delegatedOnly) {
    const ss58 = safeSs58(row.ss58);
    if (!ss58 || delegated.has(ss58)) continue;
    delegated.set(ss58, finiteNonNegative(row.delegated_tao));
  }

  const netFlow = new Map<string, Partial<Record<number, number>>>();
  for (const row of netFlowRows ?? []) {
    const ss58 = safeSs58(row.coldkey);
    if (!ss58) continue;
    netFlow.set(ss58, {
      7: finiteOrNull(row.net_flow_7d) ?? undefined,
      30: finiteOrNull(row.net_flow_30d) ?? undefined,
      90: finiteOrNull(row.net_flow_90d) ?? undefined,
    });
  }

  // Accounts that reached the artifact on net flow alone still need their real
  // holdings, or they would publish free_tao 0 and sink to the bottom of the
  // default sort while genuinely holding TAO.
  const missing = [...netFlow.keys()].filter((ss58) => !balances.has(ss58));
  if (missing.length) {
    const filled = await loadHoldingsForAccounts(d1, missing);
    if (filled === null) return null;
    for (const row of filled) {
      const ss58 = safeSs58(row.ss58);
      if (!ss58) continue;
      balances.set(ss58, {
        freeTao: finiteNonNegative(row.free_tao),
        capturedAt: finiteNonNegative(row.captured_at),
      });
    }
  }

  const rows = buildTopHoldersProjectionRows({ balances, delegated, netFlow });
  return {
    schema_version: 1,
    generated_at: new Date(now()).toISOString(),
    source: "top-holders projection lane (D1 holdings + lakehouse net flow)",
    row_count: rows.length,
    net_flow_available: netFlowAvailable,
    rows,
  };
}

interface ArtifactBucket {
  put(key: string, body: string): Promise<unknown>;
}

export interface TopHoldersRecomputeDeps extends TopHoldersComputeDeps {
  /** Telemetry seam for tests; defaults to the real recordExceptionEvent. */
  recordException?: typeof recordExceptionEvent;
}

/**
 * One recompute tick: compute, and write only on a complete answer.
 *
 * NOT a member of PROJECTION_LANES, and the three reasons it does not fit that
 * registry are the same three that make it its own cron:
 *
 *   - it reads D1 as well as the lakehouse, where every registered lane reads
 *     R2 SQL alone;
 *   - its artifact key is `metagraph/materialized/`, not the
 *     `metagraph/projections/` prefix the registry's own test enforces, because
 *     the reader has served that key since #9155 and the frozen artifact still
 *     sits there as the fallback until this lane first succeeds;
 *   - it is mainnet-only by construction (there is no testnet
 *     `account_balances`), where the registry fans every lane across
 *     PROJECTION_NETWORKS.
 *
 * Three exceptions to join a uniform registry is the registry telling you the
 * lane belongs somewhere else, so this follows the live-economics-refresh
 * shape instead: its own cron string, its own dispatch branch.
 *
 * The cadence follows its slowest input rather than the fleet's: `free_tao`
 * refreshes every six hours (ACCOUNT_BALANCES_POLL_SECS), and re-running the
 * 90-day lakehouse scan every thirty minutes would pay forty-eight times a day
 * to restate the same holdings. R2 SQL is billed by what a statement scans.
 *
 * Returns a summary rather than throwing, matching the watchdog/lane family: a
 * tick that cannot run is one missed report, not an outage.
 */
export async function runTopHoldersRecompute(
  env: Env,
  deps: TopHoldersRecomputeDeps = {},
): Promise<Record<string, unknown>> {
  const record = deps.recordException ?? recordExceptionEvent;
  const bucket = (env as unknown as { METAGRAPH_ARCHIVE?: ArtifactBucket })
    .METAGRAPH_ARCHIVE;
  if (!bucket?.put) {
    // Refuse BEFORE spending second-scale queries on an answer with nowhere
    // durable to land -- runProjectionLane's own posture.
    return { ok: false, reason: "r2_binding_missing" };
  }

  let body: Record<string, unknown> | null;
  try {
    body = await computeTopHolders(env, DEFAULT_CHAIN_NETWORK, deps);
  } catch (error) {
    await record(env, {
      error: error instanceof Error ? error : new Error(String(error)),
      route: "projection:top-holders",
      errorCode: "compute_failed",
    }).catch(() => false);
    return { ok: false, reason: "compute_failed" };
  }

  if (body === null) {
    // The expected state until the poller's account-balances lane redeploys.
    // Deliberately NOT an exception: the top-holders staleness watchdog already
    // reports this artifact's age every tick on its own cron, and a second
    // alarm for the same condition is how a channel stops being read. The
    // reader keeps serving whatever is already at the key.
    console.error(
      "[projection:top-holders] compute declined; previous artifact left in place",
    );
    return { ok: false, reason: "compute_declined" };
  }

  if (body.net_flow_available === false) {
    // Published, but say so: every net_flow_* column in this artifact is null
    // because the lakehouse could not be read, NOT because no account moved
    // stake -- and those two are indistinguishable in the response.
    await record(env, {
      error: new Error(
        "top-holders recompute published without net flow: the lakehouse " +
          "declined, so every net_flow_* column in this artifact is null for " +
          "a reason callers cannot see",
      ),
      route: "projection:top-holders",
      errorCode: "net_flow_unavailable",
    }).catch(() => false);
  }

  try {
    await bucket.put(TOP_HOLDERS_ARTIFACT_KEY, JSON.stringify(body));
  } catch (error) {
    await record(env, {
      error: error instanceof Error ? error : new Error(String(error)),
      route: "projection:top-holders",
      errorCode: "write_failed",
    }).catch(() => false);
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, rows: body.row_count, generated_at: body.generated_at };
}
