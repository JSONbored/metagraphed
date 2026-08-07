// One watchdog over EVERY table, because per-lane watchdogs only cover the
// lanes somebody remembered (#9786).
//
// Every staleness watchdog in this repo is hand-written for one table:
// `neurons-staleness`, `chain-detail-staleness`, `account-balances-staleness`,
// and so on. Each knows one table, one threshold, one cron. The consequence is
// structural, not accidental -- a table nobody wrote a watchdog for is watched
// by nothing, forever, and adding a table adds no coverage until someone
// remembers to add a watchdog too.
//
// On 2026-08-07 a one-query sweep of all 46 tables found FOUR frozen for five
// days -- `subnets`, `surfaces`, `providers`, `surface_history`, the whole
// registry cluster, whose only writer was a retired GitHub Actions lane
// (#9779). Nothing reported it. It was found by hand.
//
// ## `null` is the point
//
// A table whose staleness is meaningless -- `api_keys` grows only when someone
// signs up, `d1_migrations` only on a migration -- is declared with
// `maxAgeMs: null` and a reason. That is deliberately not the same as being
// absent from the list: absent means nobody has thought about it, and the test
// beside this file fails on absent. Every table must be CLASSIFIED, and "this
// one cannot be stale" is a classification.
//
// ## What this does NOT replace
//
// The per-lane watchdogs check SEMANTICS -- row counts, netuid coverage, pass
// completeness. This checks only "did anything arrive". Both matter, and the
// difference is exactly the `MAX(captured_at)` blind spot that let the
// metagraph look recovered while 108 of 129 netuids were still missing: a
// fresh timestamp on a partial table passes here and fails there.

import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";

/** This watchdog's own lane. */
export const TABLE_FRESHNESS_LANE = "table-freshness";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export interface FreshnessExpectation {
  /** The column carrying "when did a row last arrive". */
  column: string;
  /** `ms` = epoch milliseconds; `date` = a 'YYYY-MM-DD' text column. */
  kind: "ms" | "date";
  /** How old the newest row may be. `null` = staleness is meaningless here. */
  maxAgeMs: number | null;
  /** Why that number, or why null. Read by whoever gets the alarm. */
  reason: string;
  /** An open issue explaining a table that is ALREADY breaching, so the alarm
   * points somewhere instead of merely being loud. */
  knownIssue?: string;
}

/**
 * Every table in migrations/d1, and what its freshness means.
 *
 * Thresholds are set from MEASURED cadence (2026-08-07 sweep) with headroom,
 * not from what the producer claims. A threshold under one producer interval
 * alarms forever; one at ten times it never alarms at all.
 */
export const TABLE_FRESHNESS: Readonly<Record<string, FreshnessExpectation>> = {
  // --- live capture: minutes old in steady state -------------------------
  chain_detail_blocks: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "firehose poller, continuous",
  },
  chain_detail_extrinsics: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "firehose poller, continuous",
  },
  chain_detail_chain_events: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "firehose poller, continuous",
  },
  chain_detail_account_events: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "firehose poller, continuous",
  },
  blocks_head: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "head tracker",
  },
  raw_capture_state: {
    column: "updated_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "RAW_CAPTURE_CRON every 5 min",
  },
  raw_capture_state_v2: {
    column: "updated_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "successor table, not yet cut over",
  },
  tao_usd_index: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "TAO_USD_INDEX_CRON every minute",
  },
  lane_health: {
    column: "checked_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "every watchdog writes here; silence means they all stopped",
  },

  // --- the metagraph family: 15-minute producer --------------------------
  neurons: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "metagraph sync every 15 min",
  },
  neuron_daily: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "derived from the same sync",
  },
  account_position_daily: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "derived from the same sync",
  },
  subnet_snapshots: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 4 * HOUR,
    reason: "health prober",
  },
  subnet_hyperparams: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 12 * HOUR,
    reason: "hyperparams sync",
  },
  account_identity: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 12 * HOUR,
    reason: "identity sync",
  },

  // --- slow ledgers: 12h/30h/48h producers, measured 4.9-5.2h old ---------
  account_balances: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 24 * HOUR,
    reason: "12h producer; matches ACCOUNT_BALANCES_STALENESS_THRESHOLD_MS x2",
  },
  account_balances_passes: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 24 * HOUR,
    reason: "written with account_balances",
  },
  hotkey_alpha: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 60 * HOUR,
    reason: "48h producer; HOTKEY_ALPHA_STALENESS_THRESHOLD_MS is 48h",
  },
  hotkey_alpha_passes: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 60 * HOUR,
    reason: "written with hotkey_alpha",
  },
  // Added by 0029 while this map was being written -- which is the coverage
  // test doing its job: a new table arrived and was unwatched until named.
  // Pass ledgers are written with their parent table, so they share its
  // cadence.
  nominator_positions_passes: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 36 * HOUR,
    reason: "written with nominator_positions",
  },
  validator_nominator_counts_passes: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 36 * HOUR,
    reason: "written with validator_nominator_counts",
  },
  nominator_positions: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 36 * HOUR,
    reason: "30h producer",
  },
  validator_nominator_counts: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 36 * HOUR,
    reason: "written with nominator_positions",
  },

  // --- probe/rollup lanes -------------------------------------------------
  surface_checks: {
    column: "checked_at",
    kind: "ms",
    maxAgeMs: 4 * HOUR,
    reason: "surface prober",
  },
  surface_status: {
    column: "checked_at",
    kind: "ms",
    maxAgeMs: 4 * HOUR,
    reason: "written with surface_checks",
  },
  surface_uptime_daily: {
    column: "day",
    kind: "date",
    maxAgeMs: 48 * HOUR,
    reason: "daily rollup",
  },
  surface_failure_daily: {
    column: "day",
    kind: "date",
    maxAgeMs: 48 * HOUR,
    reason: "daily rollup",
  },
  api_usage_rollup: {
    column: "day",
    kind: "date",
    maxAgeMs: 48 * HOUR,
    reason: "daily rollup",
  },
  chain_concentration_daily: {
    column: "day",
    kind: "date",
    maxAgeMs: 72 * HOUR,
    reason: "daily rollup, and it can only cover days neuron_daily has (#9781)",
  },
  subnet_burn_history: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: 4 * HOUR,
    reason: "SUBNET_BURN_CAPTURE_CRON, 4x hourly",
  },
  emission_gate_param_history: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: 6 * HOUR,
    reason: "EMISSION_GATE_SAMPLE_CRON, 6x hourly",
  },

  // --- change-logs: they append only when something CHANGES ---------------
  account_identity_history: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "append-on-change; quiet means nobody renamed",
  },
  subnet_hyperparams_history: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "append-on-change",
  },
  subnet_emission_enabled_history: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "append-on-change",
  },

  // --- the registry cluster: CURRENTLY BROKEN, and alarmed on purpose -----
  // Not exempted. #9779 is a real outage -- the only writer was a retired
  // GitHub Actions lane -- and suppressing it here to keep the lane green
  // would be the exact thing a watchdog must never do.
  subnets: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 48 * HOUR,
    reason: "registry sync on merge",
    knownIssue: "#9779",
  },
  surfaces: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 48 * HOUR,
    reason: "registry sync on merge",
    knownIssue: "#9779",
  },
  providers: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 48 * HOUR,
    reason: "registry sync on merge",
    knownIssue: "#9779",
  },
  surface_history: {
    column: "recorded_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "append-on-change, but its writer is dead",
    knownIssue: "#9779",
  },

  // --- user state and control: change only when a human acts --------------
  api_keys: {
    column: "created_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "signup-driven",
  },
  api_key_usage_daily: {
    column: "day",
    kind: "date",
    maxAgeMs: null,
    reason: "only rows when a key is used",
  },
  api_key_blocks: {
    column: "",
    kind: "ms",
    maxAgeMs: null,
    reason: "no timestamp column",
  },
  api_quota_daily: {
    column: "day",
    kind: "date",
    maxAgeMs: null,
    reason: "only rows when a key is used",
  },
  rpc_accounts: {
    column: "created_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "signup-driven",
  },
  github_accounts: {
    column: "created_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "signup-driven",
  },
  chain_alert_triggers: {
    column: "created_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "user-created; empty until ALERT_TRIGGER_CREATE_TOKEN is set",
  },
  chain_alert_deliveries: {
    column: "",
    kind: "ms",
    maxAgeMs: null,
    reason: "no timestamp column",
  },
  watch_push_subscriptions: {
    column: "",
    kind: "ms",
    maxAgeMs: null,
    reason: "no timestamp column",
  },
  emission_flow_watch: {
    column: "updated_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "a watch list, edited by hand",
  },
};

/** The minimal D1 surface this needs, so a test can hand it a fake. */
export interface FreshnessDb {
  prepare(sql: string): { all(): Promise<{ results?: unknown[] } | null> };
}

/**
 * Tables asked about in one statement.
 *
 * D1 rejects a compound SELECT past roughly five terms
 * (`too many terms in compound SELECT`), so the sweep is batched rather than
 * issued as one 40-way UNION. Four keeps a margin under that.
 */
export const FRESHNESS_BATCH = 4;

/** The tables this sweep actually queries: those with a column to read. */
export function freshnessTables(): string[] {
  return Object.entries(TABLE_FRESHNESS)
    .filter(([, e]) => e.column !== "")
    .map(([table]) => table)
    .sort();
}

/** One batch's query. `date` columns are compared as text, which sorts. */
export function freshnessSql(
  tables: readonly string[],
  spec: Readonly<Record<string, FreshnessExpectation>> = TABLE_FRESHNESS,
): string {
  return tables
    .map((t) => `SELECT '${t}' AS t, MAX(${spec[t].column}) AS mx FROM ${t}`)
    .join(" UNION ALL ");
}

export interface StaleTable {
  table: string;
  ageMs: number;
  maxAgeMs: number;
  reason: string;
  knownIssue?: string;
}

/** Which tables are older than their own expectation, worst first. */
export function staleTables(
  newest: ReadonlyMap<string, number>,
  nowMs: number,
  spec: Readonly<Record<string, FreshnessExpectation>> = TABLE_FRESHNESS,
): StaleTable[] {
  const out: StaleTable[] = [];
  for (const [table, e] of Object.entries(spec)) {
    if (e.maxAgeMs == null) continue;
    const at = newest.get(table);
    // A table that returned no timestamp is EMPTY, not stale. An empty table
    // has no arrival to be late -- reporting it would make every
    // not-yet-populated table permanently loud.
    if (at == null) continue;
    const ageMs = nowMs - at;
    if (ageMs <= e.maxAgeMs) continue;
    out.push({
      table,
      ageMs,
      maxAgeMs: e.maxAgeMs,
      reason: e.reason,
      knownIssue: e.knownIssue,
    });
  }
  return out.sort((a, b) => b.ageMs - a.ageMs);
}

/** One line for the verdict's detail column. */
export function describeStaleTables(stale: readonly StaleTable[]): string {
  if (stale.length === 0) return "every table is within its expected age";
  return stale
    .map((s) => {
      const h = (s.ageMs / HOUR).toFixed(1);
      const cap = (s.maxAgeMs / HOUR).toFixed(0);
      return `${s.table} ${h}h > ${cap}h${s.knownIssue ? ` (known: ${s.knownIssue})` : ""}`;
    })
    .join("; ");
}

/** Parse a batch's rows into table -> epoch ms. */
export function parseFreshnessRows(
  rows: readonly unknown[],
  spec: Readonly<Record<string, FreshnessExpectation>> = TABLE_FRESHNESS,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    // NULL CHECKED BEFORE Number(): `Number(null)` is 0 and 0 passes
    // Number.isFinite, so MAX() over an empty table would read as 1970 and
    // report every empty table as decades stale.
    if (row?.t == null || row?.mx == null) continue;
    const table = String(row.t);
    const expectation = spec[table];
    if (!expectation) continue;
    const at =
      expectation.kind === "date"
        ? Date.parse(`${String(row.mx)}T00:00:00Z`)
        : Number(row.mx);
    if (Number.isFinite(at)) out.set(table, at);
  }
  return out;
}

export interface FreshnessDeps {
  db?: FreshnessDb | null;
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
  spec?: Readonly<Record<string, FreshnessExpectation>>;
}

export interface FreshnessOutcome {
  attempted: boolean;
  stale?: StaleTable[];
  checked?: number;
  reason?: string;
}

/**
 * Sweep every declared table. Never throws.
 *
 * A batch that fails does NOT fail the sweep: the other batches still carry
 * real information, and one unreadable table should not hide thirty healthy
 * ones. But if EVERY batch fails the verdict is `unknown` rather than `ok`,
 * because "nothing was measured" and "nothing is stale" must not look alike.
 */
export async function runTableFreshnessWatchdog(
  env: Record<string, unknown> | null | undefined,
  deps: FreshnessDeps = {},
): Promise<FreshnessOutcome> {
  const db = deps.db ?? (env?.METAGRAPH_HEALTH_DB as FreshnessDb | undefined);
  const laneDb =
    deps.laneHealthDb ?? (env?.METAGRAPH_HEALTH_DB as LaneHealthDb | undefined);
  const now = deps.now ?? Date.now;
  const spec = deps.spec ?? TABLE_FRESHNESS;
  const tables = Object.entries(spec)
    .filter(([, e]) => e.column !== "")
    .map(([t]) => t)
    .sort();

  const newest = new Map<string, number>();
  let batches = 0;
  let failed = 0;
  for (let i = 0; i < tables.length; i += FRESHNESS_BATCH) {
    const batch = tables.slice(i, i + FRESHNESS_BATCH);
    batches += 1;
    try {
      const result = await db?.prepare(freshnessSql(batch, spec)).all();
      if (!result) throw new Error("no result");
      for (const [table, at] of parseFreshnessRows(
        result.results ?? [],
        spec,
      )) {
        newest.set(table, at);
      }
    } catch {
      failed += 1;
    }
  }

  if (batches > 0 && failed === batches) {
    await recordLaneVerdict(laneDb, {
      lane: TABLE_FRESHNESS_LANE,
      verdict: "unknown",
      age_ms: null,
      detail: "no table could be read",
      checked_at: now(),
    });
    return { attempted: true, reason: "all batches failed" };
  }

  const stale = staleTables(newest, now(), spec);
  await recordLaneVerdict(laneDb, {
    lane: TABLE_FRESHNESS_LANE,
    verdict: stale.length === 0 ? "ok" : "stale",
    age_ms: stale.length === 0 ? null : stale[0].ageMs,
    detail:
      describeStaleTables(stale) +
      (failed > 0 ? ` | ${failed} of ${batches} batches unreadable` : ""),
    checked_at: now(),
  });
  return { attempted: true, stale, checked: newest.size };
}
