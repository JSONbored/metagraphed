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

import { laneHealthStore } from "./lane-health-store.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { readStore } from "./read-store.ts";
import { neonOwnsTable } from "./neon-write.ts";

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
    column: "observed_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "firehose poller, continuous",
  },
  chain_detail_extrinsics: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "firehose poller, continuous",
  },
  chain_detail_chain_events: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "firehose poller, continuous",
  },
  chain_detail_account_events: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "firehose poller, continuous",
  },
  blocks_head: {
    column: "observed_at",
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
    // EXCLUDED because the table does not exist in production. It is declared
    // in migrations/d1/0013_raw_capture_network.sql and was never applied (17
    // migrations later), which #9867 tracks. Sweeping it made its whole batch
    // throw, and at FRESHNESS_BATCH = 4 that blinded three healthy tables with
    // it. Left declared rather than deleted so the map still accounts for
    // every table migrations/d1 names -- the invariant
    // tests/table-freshness-watchdog.test.ts asserts.
    column: "",
    kind: "ms",
    maxAgeMs: null,
    reason:
      "declared in migrations/d1/0013 but never applied to production (#9867)",
  },
  tao_usd_index: {
    column: "observed_at",
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
  // Added by 0030 after this map was written -- the same coverage test that
  // caught 0029's two tables caught this one, which is what it is for.
  neurons_passes: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "written with neurons",
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
    column: "updated_at",
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
    column: "updated_at",
    kind: "ms",
    maxAgeMs: 48 * HOUR,
    reason: "registry sync on merge",
    knownIssue: "#9779",
  },
  surfaces: {
    column: "updated_at",
    kind: "ms",
    maxAgeMs: 48 * HOUR,
    reason: "registry sync on merge",
    knownIssue: "#9779",
  },
  providers: {
    column: "updated_at",
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
    column: "observed_at",
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
  const laneDb = laneHealthStore(env, deps.laneHealthDb);
  const now = deps.now ?? Date.now;
  const spec = deps.spec ?? TABLE_FRESHNESS;
  const tables = Object.entries(spec)
    .filter(([, e]) => e.column !== "")
    .map(([t]) => t)
    .sort();

  // PARTITIONED BY STORE, not batched across it (#10160).
  //
  // This is the one reader that spans the whole estate -- ~47 tables, and they
  // do not all live in the same place. readStore is all-or-nothing per call for
  // good reason, so a batch mixing an owned table with an unowned one falls
  // back to D1 and every Neon-only table in it throws "relation does not
  // exist". That is not a small loss: the sweep is a single UNION per batch, so
  // one wrong store condemns the batch, and the retry below then walks it a
  // table at a time only to fail on each.
  //
  // So the tables are split by owner FIRST and batched inside each half. Both
  // halves keep the same batch size: D1 caps a compound SELECT at 5 terms, and
  // matching it on the Neon side keeps one number to reason about rather than
  // two that happen to differ.
  const partitions: string[][] = deps.db
    ? [tables]
    : [
        tables.filter((t) => neonOwnsTable(env, t)),
        tables.filter((t) => !neonOwnsTable(env, t)),
      ].filter((group) => group.length > 0);

  const newest = new Map<string, number>();
  const readBatch = async (
    group: string[],
    db: FreshnessDb | undefined,
  ): Promise<boolean> => {
    try {
      const result = await db?.prepare(freshnessSql(group, spec)).all();
      if (!result) throw new Error("no result");
      for (const [table, at] of parseFreshnessRows(
        result.results ?? [],
        spec,
      )) {
        newest.set(table, at);
      }
      return true;
    } catch {
      return false;
    }
  };

  // Tables the sweep could not read, BY NAME. #9866 counted failed BATCHES,
  // which was both imprecise (one bad table condemned four) and unactionable
  // ("7 of 12 batches unreadable" names nothing to go and fix).
  const unreadable: string[] = [];
  for (const partition of partitions) {
    const db =
      deps.db ?? (readStore(env, partition) as FreshnessDb | undefined);
    for (let i = 0; i < partition.length; i += FRESHNESS_BATCH) {
      const batch = partition.slice(i, i + FRESHNESS_BATCH);
      if (await readBatch(batch, db)) continue;
      // ONE bad table used to cost its whole batch. The sweep is a single UNION
      // per batch, so a table that does not exist (or whose column does not)
      // makes the statement throw and takes its neighbours with it -- which is
      // how 12 bad entries blinded 7 of 12 batches, 58% of the estate. Retrying
      // the batch one table at a time costs at most FRESHNESS_BATCH extra round
      // trips on a path that should be empty, and localises the loss to the
      // table actually at fault.
      for (const table of batch) {
        if (!(await readBatch([table], db))) unreadable.push(table);
      }
    }
  }

  if (tables.length > 0 && unreadable.length === tables.length) {
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
  // #9866: an unreadable table must reach the VERDICT, not just the detail
  // string. It used to reach only the prose, so a sweep that read 5 of 12
  // batches still published `ok` -- "every table is within its expected age |
  // 7 of 12 batches unreadable" -- and lane-alarm keys on the verdict, so
  // nothing fired. 58% of the estate was unchecked and the lane called it
  // healthy, including the frozen registry cluster this watchdog was built
  // (#9786) to catch.
  //
  // Three outcomes, in priority order:
  //   stale   - we found a real breach. That is a finding, and it outranks an
  //             incomplete sweep: something IS wrong and the detail says what.
  //   unknown - nothing measured looks stale, but the sweep did not establish
  //             that every table is fresh -- either because a table could not
  //             be read, or because NOTHING was read (D1 can answer without a
  //             `results` key at all, which the `?? []` absorbs without
  //             throwing; absorbing the crash must not also manufacture a
  //             green).
  //   ok      - a complete sweep, over at least one table, with nothing stale.
  //             The only state that has earned the word.
  const measuredNothing = tables.length > 0 && newest.size === 0;
  const verdict =
    stale.length > 0
      ? "stale"
      : unreadable.length > 0 || measuredNothing
        ? "unknown"
        : ("ok" as const);
  await recordLaneVerdict(laneDb, {
    lane: TABLE_FRESHNESS_LANE,
    verdict,
    age_ms: stale.length === 0 ? null : stale[0].ageMs,
    detail:
      describeStaleTables(stale) +
      (unreadable.length > 0
        ? ` | ${unreadable.length} unreadable: ${unreadable.slice(0, 6).join(", ")}`
        : ""),
    checked_at: now(),
  });
  return { attempted: true, stale, checked: newest.size };
}
