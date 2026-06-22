// Chain-event index (#1346, epic #1345): the D1 `account_events` tier — first-party
// per-entity activity decoded DIRECTLY from finney by scripts/fetch-events.py
// (substrate System.Events), NOT Taostats. This module holds the load contract,
// the daily rollup + prune (retention), and the row→API shaping (#1347). Pure +
// exported for tests; the Worker runs the D1 I/O.

// Hot window for raw events; rolled into account_events_daily before prune so
// long-term per-entity history survives (mirrors the 30d surface_checks window).
export const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

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
  try {
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
