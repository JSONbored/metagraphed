// Chain-event index (#1346, epic #1345): the D1 `account_events` tier — first-party
// per-entity activity decoded DIRECTLY from finney by scripts/fetch-events.py
// (substrate System.Events), NOT Taostats. This module holds the load contract,
// the daily rollup, the prune, and the row→API shaping (#1347). Pure + exported
// for tests; the Worker runs the D1 I/O.

// D1 safety-valve: 365-day retention prevents unbounded growth before the
// Postgres cold tier (#1519) ships. pruneAccountEvents runs in HEALTH_PRUNE_CRON.
export const EVENT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

// Columns written to account_events — THE load contract. scripts/fetch-events.py
// emits rows with exactly these keys; loadStagedEvents binds them in this order.
// Values are always bound, never interpolated into SQL.
export const EVENT_INSERT_COLUMNS = [
  "block_number",
  "event_index",
  "event_kind",
  "hotkey",
  "coldkey",
  "netuid",
  "uid",
  "amount_tao",
  "observed_at",
  // The 0-based index of the extrinsic that emitted this event (#1849), read from
  // the event's phase=ApplyExtrinsic; null for Initialization/Finalization events.
  // 10 cols x ROWS_PER_STMT(10) = 100 bound params — exactly D1's ceiling.
  "extrinsic_index",
];

// The SubtensorModule events the poller indexes — entity-relevant only, which
// keeps volume ~1 MB/day (not ~100 MB/day). Kept in sync with fetch-events.py
// EXTRACTORS; positional field order verified against live finney (2026-06-21).
export const INDEXED_EVENT_KINDS = [
  "NeuronRegistered",
  "StakeAdded",
  "StakeRemoved",
  "StakeMoved",
  "AxonServed",
  "WeightsSet",
  "RootClaimed",
];

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// One D1 account_events row → a clean API event object (#1347 consumes this).
export function formatAccountEvent(row) {
  if (!row || typeof row !== "object") return null;
  return {
    block_number: row.block_number ?? null,
    event_index: row.event_index ?? null,
    event_kind: row.event_kind ?? null,
    hotkey: row.hotkey ?? null,
    coldkey: row.coldkey ?? null,
    netuid: row.netuid ?? null,
    uid: row.uid ?? null,
    amount_tao: row.amount_tao ?? null,
    observed_at: toIso(row.observed_at),
    extrinsic_index: row.extrinsic_index ?? null,
  };
}

// UTC-day bounds for the timestamp `ms`: { date: 'YYYY-MM-DD', start, end } in
// epoch ms. The rollup re-rolls the two active days each hour (past days are
// already finalized + unchanged), keyed by these bounds.
export function utcDayBounds(ms) {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return {
    date: new Date(start).toISOString().slice(0, 10),
    start,
    end: start + 24 * 60 * 60 * 1000,
  };
}

// Roll the raw account_events for the two active UTC days into the durable
// per-(hotkey, netuid, day) summary, BEFORE the hot window is pruned. Upsert keeps
// it idempotent; only hotkey-attributed events roll up (coldkey-only events like
// RootClaimed stay queryable in the hot window). No-ops when D1 is cold.
export async function rollupAccountEventsDaily(env, overrides = {}) {
  const now = overrides.now || (() => Date.now());
  const db = overrides.db || env.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return { rolled: false };
  const runAt = now();
  const days = [utcDayBounds(runAt), utcDayBounds(runAt - 24 * 60 * 60 * 1000)];
  try {
    const stmt = db.prepare(
      `INSERT INTO account_events_daily
         (hotkey, netuid, day, event_count, event_kinds, first_block, last_block, updated_at)
       SELECT
         hotkey,
         netuid,
         ? AS day,
         COUNT(*) AS event_count,
         GROUP_CONCAT(DISTINCT event_kind) AS event_kinds,
         MIN(block_number) AS first_block,
         MAX(block_number) AS last_block,
         ? AS updated_at
       FROM account_events
       WHERE hotkey IS NOT NULL AND netuid IS NOT NULL
         AND observed_at >= ? AND observed_at < ?
       GROUP BY hotkey, netuid
       ON CONFLICT(hotkey, netuid, day) DO UPDATE SET
         event_count = excluded.event_count,
         event_kinds = excluded.event_kinds,
         first_block = excluded.first_block,
         last_block = excluded.last_block,
         updated_at = excluded.updated_at`,
    );
    await db.batch(
      days.map(({ date, start, end }) => stmt.bind(date, runAt, start, end)),
    );
    return { rolled: true, days: days.map((d) => d.date) };
  } catch {
    return { rolled: false };
  }
}

// Hourly maintenance: prune raw events older than the retention window so the hot
// table stays lean (the daily rollup preserves the long-term history).
export async function pruneAccountEvents(env, overrides = {}) {
  const now = overrides.now || (() => Date.now());
  const db = overrides.db || env.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return { pruned: false };
  const cutoff = now() - (overrides.retentionMs || EVENT_RETENTION_MS);
  try {
    const result = await db
      .prepare(`DELETE FROM account_events WHERE observed_at < ?`)
      .bind(cutoff)
      .run();
    return { pruned: true, cutoff, changes: result?.meta?.changes ?? null };
  } catch {
    return { pruned: false };
  }
}

// Keep only well-formed account_events rows (a valid (block_number, event_index)
// primary key). Shared by the staged-batch loader (#1346) and the realtime ingest
// endpoint (#1360) so both reject garbage identically.
export function validEventRows(rows) {
  return Array.isArray(rows)
    ? rows.filter(
        (r) =>
          Number.isInteger(r?.block_number) &&
          Number.isInteger(r?.event_index) &&
          typeof r?.event_kind === "string" &&
          Number.isInteger(r?.observed_at),
      )
    : [];
}

// Build parameterized INSERT OR IGNORE statements for account_events rows, chunked
// under D1's 100-bound-param limit (9 cols x 10 = 90). Idempotent on (block_number,
// event_index). Values are ALWAYS bound, never interpolated — a tampered payload
// can only fail, never inject. Shared by loadStagedEvents (#1346) + the ingest
// endpoint (#1360).
export function eventInsertStatements(db, rows) {
  const cols = EVENT_INSERT_COLUMNS;
  const colList = cols.join(",");
  const ROWS_PER_STMT = 10;
  const statements = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
    const chunk = rows.slice(i, i + ROWS_PER_STMT);
    const tuples = chunk
      .map(() => `(${cols.map(() => "?").join(",")})`)
      .join(",");
    const values = chunk.flatMap((row) => cols.map((c) => row[c] ?? null));
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO account_events (${colList}) VALUES ${tuples}`,
        )
        .bind(...values),
    );
  }
  return statements;
}

// ---- Entity API builders (#1347) -------------------------------------------
// The columns the account handlers SELECT for an event row.
export const ACCOUNT_EVENT_COLUMNS =
  "block_number, event_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao, observed_at, extrinsic_index";

// One neurons-table row (subset) → an AccountRegistration: where this hotkey is
// currently registered + staked (the live cross-subnet footprint).
export function formatRegistration(row) {
  if (!row || typeof row !== "object") return null;
  return {
    netuid: row.netuid ?? null,
    uid: row.uid ?? null,
    stake_tao: row.stake_tao ?? null,
    validator_permit: Boolean(row.validator_permit),
    active: Boolean(row.active),
  };
}

// Cross-subnet account summary: event-history aggregates (from account_events,
// matched by hotkey OR coldkey) joined to current registrations (from neurons,
// by hotkey). `agg` is the single aggregate row; kinds/registrations/recent are
// row arrays. Null-safe on a cold/absent store (returns a schema-stable zero).
// Signing-activity sub-object (#1847) from the extrinsics tier, by signer. These
// are hot-window aggregates (retention-bounded), not all-time. Matched by signer
// only — an account queried by a key that did not sign won't line up with the
// account_events aggregates (which match hotkey OR coldkey). Null-safe on a cold
// store: tx_count 0, others null, modules_called [].
export function formatAccountActivity(agg, modules) {
  const a = agg || {};
  return {
    tx_count: a.tx_count ?? 0,
    last_tx_block: a.last_tx_block ?? null,
    last_tx_at: toIso(a.last_tx_at),
    total_fee_tao: a.total_fee_tao ?? null,
    modules_called: (modules || [])
      .filter((m) => m && m.call_module)
      .map((m) => ({ call_module: m.call_module, count: m.count ?? 0 })),
  };
}

export function buildAccountSummary(
  ss58,
  { agg, kinds, registrations, recent, activity, modules } = {},
) {
  const a = agg || {};
  return {
    schema_version: 1,
    ss58,
    event_count: a.c ?? 0,
    subnet_count: a.sc ?? 0,
    first_block: a.fb ?? null,
    last_block: a.lb ?? null,
    first_seen_at: toIso(a.fo),
    last_seen_at: toIso(a.lo),
    event_kinds: (kinds || [])
      .filter((k) => k && k.kind)
      .map((k) => ({ kind: k.kind, count: k.count ?? 0 })),
    registrations: (registrations || [])
      .map(formatRegistration)
      .filter(Boolean),
    recent_events: (recent || []).map(formatAccountEvent).filter(Boolean),
    activity: formatAccountActivity(activity, modules),
  };
}

// Paginated event history for one account (newest first).
export function buildAccountEvents(rows, ss58, { limit, offset } = {}) {
  const events = (rows || []).map(formatAccountEvent).filter(Boolean);
  return {
    schema_version: 1,
    ss58,
    event_count: events.length,
    limit: limit ?? null,
    offset: offset ?? null,
    events,
  };
}

// The first-party chain-event stream for one subnet (#1345 block explorer):
// the same account_events rows, filtered by netuid instead of account. Mirrors
// buildAccountEvents — newest-first, schema-stable zero for a cold/unknown subnet.
export function buildSubnetEvents(rows, netuid, { limit, offset } = {}) {
  const events = (rows || []).map(formatAccountEvent).filter(Boolean);
  return {
    schema_version: 1,
    netuid,
    event_count: events.length,
    limit: limit ?? null,
    offset: offset ?? null,
    events,
  };
}

// The subnets where this account's hotkey is currently registered.
export function buildAccountSubnets(rows, ss58) {
  const subnets = (rows || []).map(formatRegistration).filter(Boolean);
  return {
    schema_version: 1,
    ss58,
    subnet_count: subnets.length,
    subnets,
  };
}
