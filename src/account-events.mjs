// Chain-event index (#1346, epic #1345): the D1 `account_events` tier — first-party
// per-entity activity decoded DIRECTLY from finney by scripts/fetch-events.py
// (substrate System.Events), NOT Taostats. This module holds the load contract,
// the daily rollup, the prune, and the row→API shaping (#1347). Pure + exported
// for tests; the Worker runs the D1 I/O.
import {
  FEED_PAGINATION,
  clampLimit,
  clampOffset,
} from "../workers/request-params.mjs";
import { decodeCursor, encodeCursor } from "./cursor.mjs";
import {
  EXTRINSIC_READ_COLUMNS,
  buildAccountExtrinsics,
} from "./extrinsics.mjs";

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
  // The alpha leg of a stake swap (#1856): subnet alpha bought/sold, in TAO units.
  // Only StakeAdded/StakeRemoved carry it; null for every other kind. Display-only.
  "alpha_amount",
  "observed_at",
  // The 0-based index of the extrinsic that emitted this event (#1849), read from
  // the event's phase=ApplyExtrinsic; null for Initialization/Finalization events.
  // 11 cols x ROWS_PER_STMT(9) = 99 bound params — under D1's 100 ceiling.
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

// The FULL set of event kinds the poller actually ingests (scripts/fetch-events.py
// EXTRACTORS) — a superset of INDEXED_EVENT_KINDS that also covers subnet
// lifecycle, delegation, key-rotation, and the native Balances.Transfer feed.
// Used to validate the public ?kind= filter so an unknown kind 400s instead of
// forcing a full index walk. MUST stay in sync with fetch-events.py EXTRACTORS;
// scoping validation to INDEXED_EVENT_KINDS alone would wrongly reject valid kinds.
export const INGESTED_EVENT_KINDS = [
  ...INDEXED_EVENT_KINDS,
  "NetworkAdded",
  "NetworkRemoved",
  "DelegateAdded",
  "TakeDecreased",
  "TakeIncreased",
  "HotkeySwapped",
  "ColdkeySwapped",
  "Transfer",
];

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Coerce a block height or index cell to a non-negative integer, or null when
// missing, non-finite, or negative — chain positions are never negative.
function toBlockNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Round a TAO sum to rao precision (9 dp), preserving null — so a D1 SUM(fee_tao)
// never leaks accumulated IEEE-754 float noise into the payload. Mirrors `toTao`
// in src/chain-analytics.mjs (which rounds the SAME signer-total-fee value for
// /chain/signers + /chain/fees); kept null-preserving here because the activity
// aggregate is null on a cold store, not 0.
function toTaoOrNull(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1e9) / 1e9 : null;
}

// One D1 account_events row → a clean API event object (#1347 consumes this).
export function formatAccountEvent(row) {
  if (!row || typeof row !== "object") return null;
  return {
    block_number: toBlockNumber(row.block_number),
    event_index: toBlockNumber(row.event_index),
    event_kind: row.event_kind ?? null,
    hotkey: row.hotkey ?? null,
    coldkey: row.coldkey ?? null,
    netuid: row.netuid ?? null,
    uid: row.uid ?? null,
    amount_tao: row.amount_tao ?? null,
    alpha_amount: row.alpha_amount ?? null,
    observed_at: toIso(row.observed_at),
    extrinsic_index: toBlockNumber(row.extrinsic_index),
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
          r.block_number >= 0 &&
          Number.isInteger(r?.event_index) &&
          r.event_index >= 0 &&
          typeof r?.event_kind === "string" &&
          r.event_kind.length > 0 &&
          Number.isInteger(r?.observed_at),
      )
    : [];
}

// Build parameterized INSERT OR IGNORE statements for account_events rows, chunked
// under D1's 100-bound-param limit (11 cols x 9 = 99). Idempotent on (block_number,
// event_index). Values are ALWAYS bound, never interpolated — a tampered payload
// can only fail, never inject. Shared by loadStagedEvents (#1346) + the ingest
// endpoint (#1360).
export function eventInsertStatements(db, rows) {
  const cols = EVENT_INSERT_COLUMNS;
  const colList = cols.join(",");
  const ROWS_PER_STMT = 9;
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
  "block_number, event_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao, alpha_amount, observed_at, extrinsic_index";

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
    last_tx_block: toBlockNumber(a.last_tx_block),
    last_tx_at: toIso(a.last_tx_at),
    total_fee_tao: toTaoOrNull(a.total_fee_tao),
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
    first_block: toBlockNumber(a.fb),
    last_block: toBlockNumber(a.lb),
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

// Paginated event history for one account (newest first). next_cursor (#1851) is
// the opaque keyset token for the next page, or null at end-of-window.
export function buildAccountEvents(
  rows,
  ss58,
  { limit, offset, nextCursor } = {},
) {
  const events = (rows || []).map(formatAccountEvent).filter(Boolean);
  return {
    schema_version: 1,
    ss58,
    event_count: events.length,
    limit: limit ?? null,
    offset: offset ?? null,
    next_cursor: nextCursor ?? null,
    events,
  };
}

// The first-party chain-event stream for one subnet (#1345 block explorer):
// the same account_events rows, filtered by netuid instead of account. Mirrors
// buildAccountEvents — newest-first, schema-stable zero for a cold/unknown subnet.
export function buildSubnetEvents(
  rows,
  netuid,
  { limit, offset, nextCursor } = {},
) {
  const events = (rows || []).map(formatAccountEvent).filter(Boolean);
  return {
    schema_version: 1,
    netuid,
    event_count: events.length,
    limit: limit ?? null,
    offset: offset ?? null,
    next_cursor: nextCursor ?? null,
    events,
  };
}

// The decoded chain events in ONE block (#1852, block explorer): account_events
// filtered by block_number, in natural read order (event_index ASC). Mirrors
// buildBlockExtrinsics — ref is the original {ref} (numeric or 0x hash), so a
// cold/unknown ref returns schema-stable block_number:null + events:[].
export function buildBlockEvents(
  rows,
  ref,
  blockNumber,
  { limit, offset } = {},
) {
  const events = (rows || []).map(formatAccountEvent).filter(Boolean);
  return {
    schema_version: 1,
    ref: ref ?? null,
    block_number: blockNumber ?? null,
    event_count: events.length,
    limit: limit ?? null,
    offset: offset ?? null,
    events,
  };
}

// One account_events_daily row → a clean API day object (#1854). Splits the
// event_kinds GROUP_CONCAT CSV (rollupAccountEventsDaily) back into an array.
export function formatAccountDay(row) {
  if (!row || typeof row !== "object") return null;
  return {
    day: row.day ?? null,
    netuid: row.netuid ?? null,
    event_count: row.event_count ?? null,
    event_kinds:
      typeof row.event_kinds === "string" && row.event_kinds.length > 0
        ? row.event_kinds.split(",").filter(Boolean)
        : [],
    first_block: toBlockNumber(row.first_block),
    last_block: toBlockNumber(row.last_block),
  };
}

// The durable per-day activity series for one account (#1854), from the
// account_events_daily rollup (hotkey-keyed). NOTE the rollup writes only
// hotkey-attributed rows, so a coldkey-only ss58 returns zero days even when
// /events shows activity — surfaced in the route comment + contract description.
export function buildAccountHistory(
  rows,
  ss58,
  { limit, offset, nextCursor } = {},
) {
  const days = (rows || []).map(formatAccountDay).filter(Boolean);
  return {
    schema_version: 1,
    ss58,
    day_count: days.length,
    limit: limit ?? null,
    offset: offset ?? null,
    next_cursor: nextCursor ?? null,
    days,
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

// Per-account native-TAO Transfer feed (#1850), newest first. Reshapes the
// account_events rows for event_kind='Transfer' — where the _transfer extractor
// overloads hotkey=from (sender) and coldkey=to (recipient) — into a clean
// directional {from, to, amount_tao, direction} ledger, hiding the column overload
// behind the contract. `direction` is derived per-row by comparing the queried
// ss58: it sent (== from) or received (== to). This is the native-TAO
// Balances.Transfer feed only, NOT a full balance ledger (stake flows are separate
// event kinds). Null-safe on a cold store.
//
// `direction` (the option) is an INTERNAL post-filter hint: the side the loader
// already filtered the SQL on (see loadAccountTransfers / handleAccountTransfers),
// NOT a free-form caller input. ONLY the exact strings `sent`/`received` force the
// label; every other value (`all`, omitted, junk) falls back to the per-row
// hotkey-first derivation. It must only be passed when the rows are guaranteed to
// be on that side — when set, every row is labeled with it. This fixes a
// self-transfer (from === to === ss58, i.e. hotkey === coldkey === ss58) returned
// by the received-side query, which the hotkey-first per-row derivation would
// otherwise mislabel `sent`, contradicting the requested filter (#2362).
export function buildAccountTransfers(
  rows,
  ss58,
  { limit, offset, nextCursor, direction } = {},
) {
  const fixedDirection =
    direction === "sent" || direction === "received" ? direction : null;
  const transfers = (rows || [])
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      block_number: toBlockNumber(r.block_number),
      event_index: toBlockNumber(r.event_index),
      from: r.hotkey ?? null,
      to: r.coldkey ?? null,
      amount_tao: r.amount_tao ?? null,
      direction:
        fixedDirection ??
        (r.hotkey === ss58 ? "sent" : r.coldkey === ss58 ? "received" : null),
      observed_at: toIso(r.observed_at),
    }));
  return {
    schema_version: 1,
    ss58,
    transfer_count: transfers.length,
    limit: limit ?? null,
    offset: offset ?? null,
    next_cursor: nextCursor ?? null,
    transfers,
  };
}

// ---- Account D1 read paths -------------------------------------------------
// One source of truth for the account SQL + pagination, shared by the REST
// handlers and the MCP account tools. `d1` is a (sql, params) => Promise<rows[]>
// runner; a cold/unbound DB yields [] → a schema-stable zero payload.

// Events match either key (a coldkey controls hotkeys); a registration is hotkey-only.
// OR across two columns can miss index plans in SQLite/D1 (#2059), so every
// account_events read uses an indexed UNION-of-seeks (same pattern as
// loadAccountTransfers' both-direction feed).
const ACCOUNT_EVENT_HOTKEY_INDEX = "idx_account_events_hotkey";
const ACCOUNT_EVENT_COLDKEY_INDEX = "idx_account_events_coldkey";

function accountEventIndexedUnion(select, filters = "", filterParams = []) {
  const branchFilters = filters ? ` ${filters}` : "";
  return {
    sql:
      `(SELECT ${select} FROM account_events INDEXED BY ${ACCOUNT_EVENT_HOTKEY_INDEX} WHERE hotkey = ?${branchFilters}` +
      ` UNION ALL SELECT ${select} FROM account_events INDEXED BY ${ACCOUNT_EVENT_COLDKEY_INDEX} WHERE coldkey = ? AND (hotkey IS NULL OR hotkey <> ?)${branchFilters})`,
    paramsFor(ss58) {
      return [ss58, ...filterParams, ss58, ss58, ...filterParams];
    },
  };
}
const REGISTRATION_COLUMNS = "netuid, uid, stake_tao, validator_permit, active";
// Bound public account-summary signing activity to the newest signer rows. This
// keeps /api/v1/accounts/{ss58} from doing full retained-history aggregates for
// high-volume signers on every unauthenticated request.
export const ACCOUNT_ACTIVITY_RECENT_LIMIT = 1000;

// Cross-subnet summary: event aggregates, per-kind counts, the 10 newest events,
// current registrations, and bounded signing-activity aggregates from the extrinsics tier.
export async function loadAccountSummary(d1, ss58) {
  const aggUnion = accountEventIndexedUnion(
    "netuid, block_number, observed_at",
  );
  const kindUnion = accountEventIndexedUnion("event_kind");
  const recentUnion = accountEventIndexedUnion(ACCOUNT_EVENT_COLUMNS);
  const [aggRows, kindRows, regRows, recentRows, activityRows, moduleRows] =
    await Promise.all([
      d1(
        `SELECT COUNT(*) AS c, COUNT(DISTINCT netuid) AS sc, MIN(block_number) AS fb, MAX(block_number) AS lb, MIN(observed_at) AS fo, MAX(observed_at) AS lo FROM ${aggUnion.sql}`,
        aggUnion.paramsFor(ss58),
      ),
      d1(
        `SELECT event_kind AS kind, COUNT(*) AS count FROM ${kindUnion.sql} GROUP BY event_kind ORDER BY count DESC`,
        kindUnion.paramsFor(ss58),
      ),
      d1(
        `SELECT ${REGISTRATION_COLUMNS} FROM neurons WHERE hotkey = ? ORDER BY stake_tao DESC`,
        [ss58],
      ),
      d1(
        `SELECT * FROM ${recentUnion.sql} ORDER BY block_number DESC, event_index DESC LIMIT 10`,
        recentUnion.paramsFor(ss58),
      ),
      // Signing activity from the extrinsics tier, matched by signer and
      // explicitly bounded to the newest rows before aggregation. The inner
      // signer-scoped, feed-ordered seek is served by idx_extrinsics_signer_block,
      // so the bound is an indexed LIMIT, not a sort-then-truncate over the
      // signer's full retained history.
      d1(
        `SELECT COUNT(*) AS tx_count, MAX(block_number) AS last_tx_block, MAX(observed_at) AS last_tx_at, SUM(fee_tao) AS total_fee_tao FROM (SELECT block_number, observed_at, fee_tao FROM extrinsics WHERE signer = ? ORDER BY block_number DESC, extrinsic_index DESC LIMIT ?)`,
        [ss58, ACCOUNT_ACTIVITY_RECENT_LIMIT],
      ),
      d1(
        `SELECT call_module, COUNT(*) AS count FROM (SELECT call_module FROM extrinsics WHERE signer = ? ORDER BY block_number DESC, extrinsic_index DESC LIMIT ?) GROUP BY call_module ORDER BY count DESC LIMIT 10`,
        [ss58, ACCOUNT_ACTIVITY_RECENT_LIMIT],
      ),
    ]);
  return buildAccountSummary(ss58, {
    agg: aggRows[0],
    kinds: kindRows,
    registrations: regRows,
    recent: recentRows,
    activity: activityRows[0],
    modules: moduleRows,
  });
}

// Paginated event history (newest first), optional kind filter, offset or keyset
// cursor. Clamps internally so REST and MCP agree; a cursor overrides offset.
export async function loadAccountEvents(
  d1,
  ss58,
  { limit, offset, kind, cursor, blockStart, blockEnd } = {},
) {
  const lim = clampLimit(limit, FEED_PAGINATION);
  const off = clampOffset(offset);
  const filterParts = [];
  const filterParams = [];
  if (kind) {
    filterParts.push("AND event_kind = ?");
    filterParams.push(kind);
  }
  // Block-height range filter, parity with the extrinsics and chain-events
  // feeds: the per-branch hotkey/coldkey indexes both lead block_number, so a
  // bounded range stays index-satisfiable.
  if (blockStart != null) {
    filterParts.push("AND block_number >= ?");
    filterParams.push(blockStart);
  }
  if (blockEnd != null) {
    filterParts.push("AND block_number <= ?");
    filterParams.push(blockEnd);
  }
  const cur = decodeCursor(cursor, 2);
  const useCursor = Boolean(cur);
  if (useCursor) {
    filterParts.push("AND (block_number, event_index) < (?, ?)");
    filterParams.push(cur[0], cur[1]);
  }
  const union = accountEventIndexedUnion(
    ACCOUNT_EVENT_COLUMNS,
    filterParts.join(" "),
    filterParams,
  );
  const params = [...union.paramsFor(ss58), lim];
  let sql = `SELECT * FROM ${union.sql} ORDER BY block_number DESC, event_index DESC LIMIT ?`;
  if (!useCursor) {
    sql += " OFFSET ?";
    params.push(off);
  }
  const rows = await d1(sql, params);
  const last = rows.length === lim ? rows[rows.length - 1] : null;
  const nextCursor = last
    ? encodeCursor([last.block_number, last.event_index])
    : null;
  return buildAccountEvents(rows, ss58, {
    limit: lim,
    offset: off,
    nextCursor,
  });
}

// The subnets where this account's hotkey is currently registered — the
// cross-subnet footprint, ordered by netuid.
export async function loadAccountSubnets(d1, ss58) {
  const rows = await d1(
    `SELECT ${REGISTRATION_COLUMNS} FROM neurons WHERE hotkey = ? ORDER BY netuid`,
    [ss58],
  );
  return buildAccountSubnets(rows, ss58);
}

// ---- Account tail loaders (history, extrinsics, transfers) -----------------
// These complete the account chain-data surface for the MCP server, following
// the same loader-sharing pattern as loadAccount{Summary,Events,Subnets}.

// Columns selected from the account_events_daily rollup (#1854). Only hotkey-
// attributed rows are written, so a coldkey-only ss58 may return zero days.
const ACCOUNT_DAY_COLUMNS =
  "day, netuid, event_count, event_kinds, first_block, last_block";

// Per-day activity series for one account, from the account_events_daily
// rollup. ?netuid narrows to one subnet; ?from / ?to are YYYY-MM-DD bounds
// (lexicographic on the TEXT `day` column). Newest day first. Clamps limit to
// 1-1000 (default 100); clamps offset to 0-1 000 000. Null-safe on cold store.
export async function loadAccountHistory(
  d1,
  ss58,
  { netuid, from, to, limit, offset } = {},
) {
  const lim = clampLimit(limit, FEED_PAGINATION);
  const off = clampOffset(offset);
  const params = [ss58];
  let sql = `SELECT ${ACCOUNT_DAY_COLUMNS} FROM account_events_daily WHERE hotkey = ?`;
  if (netuid != null && Number.isInteger(netuid)) {
    sql += " AND netuid = ?";
    params.push(netuid);
  }
  if (from) {
    sql += " AND day >= ?";
    params.push(from);
  }
  if (to) {
    sql += " AND day <= ?";
    params.push(to);
  }
  sql += " ORDER BY day DESC LIMIT ? OFFSET ?";
  params.push(lim, off);
  const rows = await d1(sql, params);
  return buildAccountHistory(rows, ss58, { limit: lim, offset: off });
}

// Extrinsics signed by this account, newest first. Matched by the extrinsic
// SIGNER only (not hotkey/coldkey union) — `extrinsics` carries a single
// `signer` column. Clamps limit to 1-1000 (default 100); clamps offset. A
// cursor takes precedence over offset for stable head-growing pages.
export async function loadAccountExtrinsics(
  d1,
  ss58,
  { limit, offset, cursor, blockStart, blockEnd } = {},
) {
  const lim = clampLimit(limit, FEED_PAGINATION);
  const off = clampOffset(offset);
  const params = [ss58];
  let sql = `SELECT ${EXTRINSIC_READ_COLUMNS} FROM extrinsics WHERE signer = ?`;
  if (blockStart != null) {
    sql += " AND block_number >= ?";
    params.push(blockStart);
  }
  if (blockEnd != null) {
    sql += " AND block_number <= ?";
    params.push(blockEnd);
  }
  const cur = decodeCursor(cursor, 2);
  const useCursor = Boolean(cur);
  if (useCursor) {
    sql += " AND (block_number, extrinsic_index) < (?, ?)";
    params.push(cur[0], cur[1]);
  }
  sql += " ORDER BY block_number DESC, extrinsic_index DESC LIMIT ?";
  params.push(lim);
  if (!useCursor) {
    sql += " OFFSET ?";
    params.push(off);
  }
  const rows = await d1(sql, params);
  const last = rows.length === lim ? rows[rows.length - 1] : null;
  const nextCursor = last
    ? encodeCursor([last.block_number, last.extrinsic_index])
    : null;
  return buildAccountExtrinsics(rows, ss58, {
    limit: lim,
    offset: off,
    nextCursor,
  });
}

// Native-TAO transfer feed for this account, from account_events where
// event_kind='Transfer' (hotkey=from, coldkey=to). direction: 'sent' | 'received'
// | null (both). Newest first. Clamps limit to 1-1000 (default 100).
export async function loadAccountTransfers(
  d1,
  ss58,
  { direction, limit, offset, blockStart, blockEnd } = {},
) {
  const lim = clampLimit(limit, FEED_PAGINATION);
  const off = clampOffset(offset);
  const rangeClause = `${blockStart != null ? " AND block_number >= ?" : ""}${blockEnd != null ? " AND block_number <= ?" : ""}`;
  const pushRangeParams = (params) => {
    if (blockStart != null) params.push(blockStart);
    if (blockEnd != null) params.push(blockEnd);
  };
  let sql;
  let params;
  if (direction === "sent") {
    params = [ss58];
    pushRangeParams(params);
    sql = `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events INDEXED BY idx_account_events_hotkey WHERE event_kind = 'Transfer' AND hotkey = ?${rangeClause}`;
  } else if (direction === "received") {
    params = [ss58];
    pushRangeParams(params);
    sql = `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events INDEXED BY idx_account_events_coldkey WHERE event_kind = 'Transfer' AND coldkey = ?${rangeClause}`;
  } else {
    params = [ss58];
    pushRangeParams(params);
    params.push(ss58, ss58);
    pushRangeParams(params);
    sql = `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM (SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events INDEXED BY idx_account_events_hotkey WHERE event_kind = 'Transfer' AND hotkey = ?${rangeClause} UNION ALL SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events INDEXED BY idx_account_events_coldkey WHERE event_kind = 'Transfer' AND coldkey = ? AND hotkey <> ?${rangeClause})`;
  }
  sql += " ORDER BY block_number DESC, event_index DESC LIMIT ? OFFSET ?";
  params.push(lim, off);
  const rows = await d1(sql, params);
  return buildAccountTransfers(rows, ss58, {
    limit: lim,
    offset: off,
    direction,
  });
}
