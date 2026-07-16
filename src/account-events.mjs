// Chain-event index (#1346, epic #1345): the D1 `account_events` tier — first-party
// per-entity activity decoded DIRECTLY from finney by scripts/fetch-events.py
// (substrate System.Events), NOT Taostats. This module holds the load contract,
// the daily rollup, the prune, and the row→API shaping (#1347). Pure + exported
// for tests; the Worker runs the D1 I/O.
import {
  DAY_PATTERN,
  FEED_PAGINATION,
  clampLimit,
  clampOffset,
} from "../workers/request-params.mjs";
import { decodeCursor, encodeCursor } from "./cursor.mjs";

// The SubtensorModule events the poller indexes — entity-relevant only, which
// keeps volume ~1 MB/day (not ~100 MB/day). Kept in sync with fetch-events.py
// EXTRACTORS; positional field order verified against live finney (2026-06-21).
export const INDEXED_EVENT_KINDS = [
  "NeuronRegistered",
  "StakeAdded",
  "StakeRemoved",
  "StakeMoved",
  "AxonServed",
  "PrometheusServed",
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
  // Stake moved between two coldkeys (#2556). Ingestible for the kind filter but
  // deliberately NOT in INDEXED_EVENT_KINDS: only the origin leg (origin_coldkey,
  // hotkey, origin_netuid, amount) fits the shared account_events columns, so it
  // is not part of the minimal indexed core the way StakeAdded/Removed/Moved are.
  "StakeTransferred",
  "NeuronDeregistered",
  "NetworkAdded",
  "NetworkRemoved",
  "RegistrationAllowed",
  "PowRegistrationAllowed",
  "BurnSet",
  "SubnetOwnerHotkeySet",
  "DelegateAdded",
  "TakeDecreased",
  "TakeIncreased",
  "HotkeySwapped",
  "ColdkeySwapped",
  "ColdkeySwapScheduled",
  // #2555 forward-compat: absent finney spec 424 today; ?kind= accepts once runtime emits
  "AxonInfoRemoved",
  "Faucet",
  "Transfer",
  // Found by the 2026-07-14/15 exhaustive decode audit: indexer-rs's Rust
  // extract() (apps/indexer-rs/src/main.rs) has always curated these -- field
  // values decode correctly (SS58/numbers, never raw) -- but the JS serving
  // allowlist never learned their names, so ?kind= 400ed on them and they fell
  // into the "other" event-summary bucket despite being high-frequency
  // (TimelockedWeightsCommitted alone was ~27% of one subnet's weekly volume).
  // CRV3WeightsCommitted/Revealed are TimelockedWeights*'s predecessor variant
  // (superseded on the current runtime, confirmed absent from a live 1000-event
  // sample) -- included for historical blocks indexer-rs may still have
  // processed under the older runtime spec.
  "CRV3WeightsCommitted",
  "CRV3WeightsRevealed",
  "TimelockedWeightsCommitted",
  "TimelockedWeightsRevealed",
  "AutoStakeAdded",
  "StakeSwapped",
  // Native substrate frame/balances Event enum, not SubtensorModule-specific.
  "Deposit",
  "Withdraw",
  "Reserved",
  "Unreserved",
  "Endowed",
  "DustLost",
  "Issued",
];

export const SUBNET_EVENT_SUMMARY_WINDOWS = { "7d": 7, "30d": 30, "90d": 90 };
export const DEFAULT_SUBNET_EVENT_SUMMARY_WINDOW = "30d";
export const SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT = 10;
export const SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX = 50;

const EVENT_KIND_CATEGORIES = {
  NeuronRegistered: "registration",
  NeuronDeregistered: "registration",
  NetworkAdded: "registration",
  NetworkRemoved: "registration",
  RegistrationAllowed: "registration",
  PowRegistrationAllowed: "registration",
  Faucet: "registration",
  StakeAdded: "stake",
  StakeRemoved: "stake",
  StakeMoved: "stake",
  StakeTransferred: "stake",
  AxonServed: "serving",
  PrometheusServed: "serving",
  AxonInfoRemoved: "serving",
  WeightsSet: "consensus",
  RootClaimed: "consensus",
  DelegateAdded: "delegation",
  TakeDecreased: "delegation",
  TakeIncreased: "delegation",
  HotkeySwapped: "identity",
  ColdkeySwapped: "identity",
  ColdkeySwapScheduled: "identity",
  SubnetOwnerHotkeySet: "governance",
  BurnSet: "governance",
  Transfer: "transfer",
  CRV3WeightsCommitted: "consensus",
  CRV3WeightsRevealed: "consensus",
  TimelockedWeightsCommitted: "consensus",
  TimelockedWeightsRevealed: "consensus",
  AutoStakeAdded: "stake",
  StakeSwapped: "stake",
  Deposit: "transfer",
  Withdraw: "transfer",
  Reserved: "transfer",
  Unreserved: "transfer",
  Endowed: "transfer",
  DustLost: "transfer",
  Issued: "transfer",
};

function toIso(ms) {
  // D1 can return the INTEGER observed_at as a numeric string; coerce first, and
  // require n > 0 so a null/blank/zero/invalid cell stays null instead of epoch
  // 1970. Mirrors the toIso guards in blocks.mjs (#2708) and extrinsics.mjs
  // (#2714).
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// Coerce a block height or index cell to a non-negative integer, or null when
// missing, non-finite, or negative — chain positions are never negative.
function toBlockNumber(value) {
  if (value == null) return null;
  // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
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
  // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1e9) / 1e9 : null;
}

function toTaoOrZero(value) {
  return toTaoOrNull(value) ?? 0;
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function eventKindCategory(kind) {
  return EVENT_KIND_CATEGORIES[kind] ?? "other";
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
    // Coerce netuid / uid (D1 INTEGER columns, can return as numeric strings)
    // through toBlockNumber so a bare `?? null` pass-through never leaks the
    // string form into the API payload. Same shape as the coercion applied to
    // block_number / event_index / extrinsic_index directly below — and to the
    // sibling formatters in blocks.mjs (#2435) and extrinsics.mjs (#2439).
    netuid: toBlockNumber(row.netuid),
    uid: toBlockNumber(row.uid),
    // amount_tao / alpha_amount (D1 REAL columns) — coerce through toTaoOrNull
    // so a numeric string never leaks the string form into the JSON payload,
    // and SUM float noise is rounded to rao precision. Mirrors the coercion
    // applied in formatRegistration (#2487) and the sibling formatters.
    amount_tao: toTaoOrNull(row.amount_tao),
    alpha_amount: toTaoOrNull(row.alpha_amount),
    observed_at: toIso(row.observed_at),
    extrinsic_index: toBlockNumber(row.extrinsic_index),
  };
}

// ---- Entity API builders (#1347) -------------------------------------------
// The columns the account handlers SELECT for an event row.
export const ACCOUNT_EVENT_COLUMNS =
  "block_number, event_index, event_kind, hotkey, coldkey, netuid, uid, amount_tao, alpha_amount, observed_at, extrinsic_index";

// Coerce a D1 0/1 INTEGER flag cell to a boolean. Numeric strings like "0"
// must not pass through Boolean(), which treats any non-empty string as true.
function toD1Flag(value) {
  return Number(value) === 1;
}

// One neurons-table row (subset) → an AccountRegistration: where this hotkey is
// currently registered + staked (the live cross-subnet footprint).
export function formatRegistration(row) {
  if (!row || typeof row !== "object") return null;
  return {
    netuid: toBlockNumber(row.netuid),
    uid: toBlockNumber(row.uid),
    stake_tao: toTaoOrNull(row.stake_tao),
    validator_permit: toD1Flag(row.validator_permit),
    active: toD1Flag(row.active),
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
    tx_count: toBlockNumber(a.tx_count) ?? 0,
    last_tx_block: toBlockNumber(a.last_tx_block),
    last_tx_at: toIso(a.last_tx_at),
    total_fee_tao: toTaoOrNull(a.total_fee_tao),
    modules_called: (modules || [])
      .filter((m) => m && m.call_module)
      .map((m) => ({
        call_module: m.call_module,
        count: toBlockNumber(m.count) ?? 0,
      })),
  };
}

export function buildAccountSummary(
  ss58,
  { agg, kinds, scanned, registrations, recent, activity, modules } = {},
) {
  const a = agg || {};
  const eventCount = toBlockNumber(a.c) ?? 0;
  const scannedCount =
    scanned != null ? (toBlockNumber(scanned) ?? 0) : eventCount;
  // event_count / subnet_count / event_kinds are aggregated over exactly the
  // account's newest ACCOUNT_EVENT_SUMMARY_SCAN_CAP events. `scanned` is a probe
  // COUNT over CAP+1: when it exceeds CAP the account has more events than that
  // window, so those totals are a lower bound and the window's MIN(block_number) /
  // MIN(observed_at) are its floor, not the account's all-time first — flag it and
  // null first_*. `> CAP` (not `>=`) means an account with EXACTLY CAP events is
  // complete (the probe found no extra row), so its totals + first_* stay exact.
  // last_* stay exact regardless (the newest events include the latest).
  const eventScanCapped = scannedCount > ACCOUNT_EVENT_SUMMARY_SCAN_CAP;
  return {
    schema_version: 1,
    ss58,
    event_count: eventCount,
    subnet_count: toBlockNumber(a.sc) ?? 0,
    event_scan_capped: eventScanCapped,
    first_block: eventScanCapped ? null : toBlockNumber(a.fb),
    last_block: toBlockNumber(a.lb),
    first_seen_at: eventScanCapped ? null : toIso(a.fo),
    last_seen_at: toIso(a.lo),
    event_kinds: (kinds || [])
      .filter((k) => k && k.kind)
      .map((k) => ({ kind: k.kind, count: toBlockNumber(k.count) ?? 0 })),
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

function emptyCategory(category) {
  return {
    category,
    event_count: 0,
    kind_count: 0,
    amount_tao: 0,
    alpha_amount: 0,
    first_block: null,
    last_block: null,
    first_observed_at: null,
    last_observed_at: null,
  };
}

function mergeObserved(existing, next, choose) {
  const nextValue = Number(next);
  if (!Number.isFinite(nextValue) || nextValue <= 0) return existing;
  if (existing == null) return nextValue;
  return choose(existing, nextValue);
}

// Windowed event summary for one subnet: compact kind/category counts plus a
// small newest-first evidence slice. This complements /subnets/{netuid}/events,
// which exposes the raw paginated feed.
export function buildSubnetEventSummary(
  kindRows,
  recentRows,
  netuid,
  { window, limit } = {},
) {
  const eventKinds = [];
  const categories = new Map();
  let latestObserved = null;
  for (const row of Array.isArray(kindRows) ? kindRows : []) {
    const kind =
      typeof row?.event_kind === "string" && row.event_kind.length > 0
        ? row.event_kind
        : null;
    if (!kind) continue;
    const category = eventKindCategory(kind);
    const eventCount = toCount(row.event_count);
    const amountTao = toTaoOrZero(row.amount_tao);
    const alphaAmount = toTaoOrZero(row.alpha_amount);
    const firstObservedMs = mergeObserved(
      null,
      row.first_observed_at,
      Math.min,
    );
    const lastObservedMs = mergeObserved(null, row.last_observed_at, Math.max);
    const shaped = {
      event_kind: kind,
      category,
      event_count: eventCount,
      hotkey_count: toCount(row.hotkey_count),
      coldkey_count: toCount(row.coldkey_count),
      amount_tao: amountTao,
      alpha_amount: alphaAmount,
      first_block: toBlockNumber(row.first_block),
      last_block: toBlockNumber(row.last_block),
      first_observed_at: toIso(firstObservedMs),
      last_observed_at: toIso(lastObservedMs),
    };
    eventKinds.push(shaped);
    const summary = categories.get(category) ?? emptyCategory(category);
    summary.event_count += eventCount;
    summary.kind_count += 1;
    summary.amount_tao = toTaoOrZero(summary.amount_tao + amountTao);
    summary.alpha_amount = toTaoOrZero(summary.alpha_amount + alphaAmount);
    summary.first_block =
      summary.first_block == null
        ? shaped.first_block
        : shaped.first_block == null
          ? summary.first_block
          : Math.min(summary.first_block, shaped.first_block);
    summary.last_block =
      summary.last_block == null
        ? shaped.last_block
        : shaped.last_block == null
          ? summary.last_block
          : Math.max(summary.last_block, shaped.last_block);
    summary.first_observed_at = toIso(
      mergeObserved(
        summary.first_observed_at == null
          ? null
          : Date.parse(summary.first_observed_at),
        firstObservedMs,
        Math.min,
      ),
    );
    summary.last_observed_at = toIso(
      mergeObserved(
        summary.last_observed_at == null
          ? null
          : Date.parse(summary.last_observed_at),
        lastObservedMs,
        Math.max,
      ),
    );
    categories.set(category, summary);
    latestObserved = mergeObserved(latestObserved, lastObservedMs, Math.max);
  }
  eventKinds.sort(
    (a, b) =>
      b.event_count - a.event_count ||
      a.category.localeCompare(b.category) ||
      a.event_kind.localeCompare(b.event_kind),
  );
  const categoryList = [...categories.values()].sort(
    (a, b) =>
      b.event_count - a.event_count || a.category.localeCompare(b.category),
  );
  const recentEvents = (Array.isArray(recentRows) ? recentRows : [])
    .map(formatAccountEvent)
    .filter(Boolean);
  for (const event of recentEvents) {
    latestObserved = mergeObserved(
      latestObserved,
      event.observed_at == null ? null : Date.parse(event.observed_at),
      Math.max,
    );
  }
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    observed_at: toIso(latestObserved),
    total_events: eventKinds.reduce((sum, row) => sum + row.event_count, 0),
    kind_count: eventKinds.length,
    category_count: categoryList.length,
    recent_event_count: recentEvents.length,
    limit: limit ?? null,
    categories: categoryList,
    event_kinds: eventKinds,
    recent_events: recentEvents,
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
// event_kinds GROUP_CONCAT CSV back into an array.
export function formatAccountDay(row) {
  if (!row || typeof row !== "object") return null;
  return {
    day: row.day ?? null,
    // Coerce netuid / event_count (D1 INTEGER columns, can return as numeric
    // strings) through toBlockNumber so a bare `?? null` pass-through never
    // leaks the string form into the API payload. Same shape as the coercion
    // applied in formatAccountEvent above (#2481) and the sibling formatters
    // in blocks.mjs (#2435) / extrinsics.mjs (#2439).
    netuid: toBlockNumber(row.netuid),
    event_count: toBlockNumber(row.event_count),
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
//
// NOT price-at-tx enriched (#4332/6.3, which named this route as one of its
// two targets): a Balances.Transfer moves native TAO between accounts with no
// subnet/netuid involved at all, so there is no alpha price that could apply
// to a row here. See src/account-stake-moves.mjs's header for the sibling
// route this WAS enriched on (StakeMoved rows are netuid-scoped).
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
      amount_tao: toTaoOrNull(r.amount_tao),
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

// Bound the account-summary EVENT aggregates: buildAccountSummary flags
// event_scan_capped when a probe COUNT over the account's newest events exceeds
// this cap, so the summary window stays bounded for high-volume coldkeys.
export const ACCOUNT_EVENT_SUMMARY_SCAN_CAP = 5000;

// ---- Account tail loaders (history, transfers) -----------------------------
// These complete the account chain-data surface for the MCP server, sharing the
// same loader pattern (clamp, cursor, schema-stable zero) as the other account
// read paths.

// Columns selected from the account_events_daily rollup (#1854). Only hotkey-
// attributed rows are written, so a coldkey-only ss58 may return zero days.
const ACCOUNT_DAY_COLUMNS =
  "day, netuid, event_count, event_kinds, first_block, last_block";

// Per-day activity series for one account, from the account_events_daily
// rollup. ?netuid narrows to one subnet; ?from / ?to are YYYY-MM-DD bounds
// (lexicographic on the TEXT `day` column). Newest day first. Clamps limit to
// 1-1000 (default 100); clamps offset to 0-1 000 000. Null-safe on cold store.
//
// account_events_daily holds one row per (hotkey, day, netuid), so `day` alone
// is not a total order — an account active on several subnets has multiple rows
// per day. Ordering by `day DESC` only left same-day rows in an unspecified
// order, which made offset paging non-deterministic (a page boundary inside a
// day could drop or repeat a same-day row). Tie-break on `netuid DESC` so the
// order is total, and expose the same `(day, netuid)` keyset cursor the REST
// handler (handleAccountHistory) and the sibling tail loaders use, so callers
// can page stable head-growing windows. A cursor takes precedence over offset;
// a cursor that does not decode to a valid YYYY-MM-DD day is ignored (falls back
// to the first page), preserving the never-throw contract.
export async function loadAccountHistory(
  d1,
  ss58,
  { netuid, from, to, limit, offset, cursor } = {},
) {
  const lim = clampLimit(limit, FEED_PAGINATION);
  const off = clampOffset(offset);
  // Inverted YYYY-MM-DD bounds are a deterministic no-match. Short-circuit before
  // D1 so REST and MCP callers cannot force a scan to prove an impossible empty page.
  if (from && to && from > to) {
    return buildAccountHistory([], ss58, {
      limit: lim,
      offset: off,
      nextCursor: null,
    });
  }
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
  const cur = decodeCursor(cursor, 2);
  const cursorDay = cur
    ? String(cur[0]).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")
    : null;
  const useCursor = Boolean(cursorDay && DAY_PATTERN.test(cursorDay));
  if (useCursor) {
    sql += " AND (day, netuid) < (?, ?)";
    params.push(cursorDay, cur[1]);
  }
  sql += " ORDER BY day DESC, netuid DESC LIMIT ?";
  params.push(lim);
  if (!useCursor) {
    sql += " OFFSET ?";
    params.push(off);
  }
  const rows = await d1(sql, params);
  const last = rows.length === lim ? rows[rows.length - 1] : null;
  const nextCursor =
    last && typeof last.day === "string" && DAY_PATTERN.test(last.day)
      ? encodeCursor([Number(last.day.replaceAll("-", "")), last.netuid])
      : null;
  return buildAccountHistory(rows, ss58, {
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
  { direction, limit, offset, cursor, blockStart, blockEnd } = {},
) {
  const lim = clampLimit(limit, FEED_PAGINATION);
  const off = clampOffset(offset);
  // Inverted block-height bounds are a deterministic no-match. Short-circuit before
  // D1 so REST and MCP callers cannot force a scan to prove an impossible empty page.
  if (blockStart != null && blockEnd != null && blockStart > blockEnd) {
    return buildAccountTransfers([], ss58, {
      limit: lim,
      offset: off,
      nextCursor: null,
      direction,
    });
  }
  const cur = decodeCursor(cursor, 2);
  const useCursor = Boolean(cur);
  const blockRangeClause = `${blockStart != null ? " AND block_number >= ?" : ""}${blockEnd != null ? " AND block_number <= ?" : ""}`;
  const cursorClause = useCursor
    ? " AND (block_number, event_index) < (?, ?)"
    : "";
  const pushBlockRangeParams = (params) => {
    if (blockStart != null) params.push(blockStart);
    if (blockEnd != null) params.push(blockEnd);
  };
  const pushCursorParams = (params) => {
    if (useCursor) params.push(cur[0], cur[1]);
  };
  let sql;
  let params;
  if (direction === "sent") {
    params = [ss58];
    pushBlockRangeParams(params);
    pushCursorParams(params);
    sql = `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events INDEXED BY idx_account_events_hotkey WHERE event_kind = 'Transfer' AND hotkey = ?${blockRangeClause}${cursorClause}`;
  } else if (direction === "received") {
    params = [ss58];
    pushBlockRangeParams(params);
    pushCursorParams(params);
    sql = `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events INDEXED BY idx_account_events_coldkey WHERE event_kind = 'Transfer' AND coldkey = ?${blockRangeClause}${cursorClause}`;
  } else {
    params = [ss58];
    pushBlockRangeParams(params);
    pushCursorParams(params);
    params.push(ss58, ss58);
    pushBlockRangeParams(params);
    pushCursorParams(params);
    sql = `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM (SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events INDEXED BY idx_account_events_hotkey WHERE event_kind = 'Transfer' AND hotkey = ?${blockRangeClause}${cursorClause} UNION ALL SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events INDEXED BY idx_account_events_coldkey WHERE event_kind = 'Transfer' AND coldkey = ? AND hotkey <> ?${blockRangeClause}${cursorClause})`;
  }
  sql += " ORDER BY block_number DESC, event_index DESC LIMIT ?";
  params.push(lim);
  if (!useCursor) {
    sql += " OFFSET ?";
    params.push(off);
  }
  const rows = await d1(sql, params);
  const last = rows.length === lim ? rows[rows.length - 1] : null;
  const nextCursor = last
    ? encodeCursor([last.block_number, last.event_index])
    : null;
  return buildAccountTransfers(rows, ss58, {
    limit: lim,
    offset: off,
    nextCursor,
    direction,
  });
}
