// Account counterparty / fund-flow analytics: who one account transacts with,
// aggregated from the account_events Transfer tier (hotkey = from, coldkey = to,
// amount_tao). Pure + exported for unit tests; the Worker does the D1 read +
// envelope. Null-safe: no transfers → a schema-stable empty list (never throws),
// matching the live account tiers the entity handlers already own.

// The account_events columns the counterparties handler reads — its D1 read
// contract (mirrors BLOCK_READ_COLUMNS / TURNOVER_READ_COLUMNS). A bare coldkey
// column name is public metagraph vocabulary, not a secret; kept in src/ next to
// its consumer so the Worker handler stays a thin SELECT.
export const COUNTERPARTIES_READ_COLUMNS =
  "hotkey, coldkey, amount_tao, block_number";

// The columns the inner scan must expose so the bounded newest-first read can
// tie-break same-block rows on event_index (the output still projects only
// COUNTERPARTIES_READ_COLUMNS — event_index is needed for ORDER BY, not the body).
export const COUNTERPARTIES_SCAN_COLUMNS = `${COUNTERPARTIES_READ_COLUMNS}, event_index`;

export const COUNTERPARTY_RELATIONSHIP_READ_COLUMNS =
  "block_number, event_index, hotkey, coldkey, netuid, amount_tao, observed_at";

// Bound the transfer scan so a hot wallet can't force an unbounded read. Rows are
// read newest-first; the summary flags when the cap truncated older history.
export const COUNTERPARTIES_SCAN_CAP = 5000;
export const COUNTERPARTY_RELATIONSHIP_SCAN_CAP = 5000;

// Coerce one raw cell to a finite number (or 0) for summation.
function numeric(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Round a TAO sum to rao precision so accumulated float error never leaks a long
// tail into the JSON.
function round(value, dp = 9) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

function nullableNumber(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? round(n) : null;
}

function nullableInteger(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function nullableTimestamp(value) {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIso(timestamp) {
  return timestamp == null ? null : new Date(timestamp).toISOString();
}

// Aggregate an account's Transfer rows into per-counterparty fund flow: for each
// transfer the account is one side of, attribute the amount to the OTHER party as
// sent (account = from) or received (account = to). Returns the top-`limit`
// counterparties by total volume (sent + received), each with net flow, count, and
// last block, plus a summary over the full scanned set. Null-safe.
export function buildCounterparties(rows, ss58, { limit = 20 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const byParty = new Map();
  let totalSent = 0;
  let totalReceived = 0;
  for (const row of list) {
    const from = row?.hotkey;
    const to = row?.coldkey;
    const amount = numeric(row?.amount_tao);
    const isSender = from === ss58;
    const isReceiver = to === ss58;
    // The counterparty is the side that ISN'T this account. Skip self-transfers
    // (both sides the account) and rows missing the other side's address.
    let party = null;
    let sent = 0;
    let received = 0;
    if (isSender && !isReceiver && typeof to === "string" && to.length > 0) {
      party = to;
      sent = amount;
    } else if (
      isReceiver &&
      !isSender &&
      typeof from === "string" &&
      from.length > 0
    ) {
      party = from;
      received = amount;
    }
    if (party == null) continue;
    totalSent += sent;
    totalReceived += received;
    const entry = byParty.get(party) ?? {
      address: party,
      sent: 0,
      received: 0,
      count: 0,
      lastBlock: null,
    };
    entry.sent += sent;
    entry.received += received;
    entry.count += 1;
    // `row` is non-null here (it produced a party), so no optional chain needed.
    // Coerce the cell (D1 can return an INTEGER column as a numeric string) so a
    // string block_number still updates last_block — matching the coercion the
    // sibling buildCounterpartyRelationship already applies via nullableInteger.
    const block = nullableInteger(row.block_number);
    if (block != null && (entry.lastBlock == null || block > entry.lastBlock)) {
      entry.lastBlock = block;
    }
    byParty.set(party, entry);
  }

  const ranked = [...byParty.values()]
    .map((entry) => ({
      address: entry.address,
      sent_tao: round(entry.sent),
      received_tao: round(entry.received),
      net_tao: round(entry.received - entry.sent),
      transfer_count: entry.count,
      last_block: entry.lastBlock,
    }))
    .sort((a, b) => {
      const volumeDelta =
        b.sent_tao + b.received_tao - (a.sent_tao + a.received_tao);
      if (volumeDelta !== 0) return volumeDelta;
      const blockDelta = (b.last_block ?? 0) - (a.last_block ?? 0);
      if (blockDelta !== 0) return blockDelta;
      // Counterparties are distinct Map keys, so addresses are never equal here.
      return a.address < b.address ? -1 : 1;
    });

  const cap = Math.max(1, Math.min(limit, 100));
  return {
    schema_version: 1,
    ss58,
    counterparty_count: byParty.size,
    transfers_scanned: list.length,
    scan_capped: list.length >= COUNTERPARTIES_SCAN_CAP,
    total_sent_tao: round(totalSent),
    total_received_tao: round(totalReceived),
    counterparties: ranked.slice(0, cap),
  };
}

// Drill into ONE account/counterparty relationship. The handler reads a bounded
// newest-first pair scan; this builder summarizes that scan and returns the first
// `limit` transfer rows as evidence, preserving the account-relative direction.
export function buildCounterpartyRelationship(
  rows,
  ss58,
  counterparty,
  { limit = 50 } = {},
) {
  const list = Array.isArray(rows) ? rows : [];
  const transfers = [];
  let totalSent = 0;
  let totalReceived = 0;
  let firstBlock = null;
  let lastBlock = null;
  let firstObserved = null;
  let lastObserved = null;

  for (const row of list) {
    if (ss58 === counterparty) continue;
    if (!row || typeof row !== "object") continue;
    const from = row.hotkey ?? null;
    const to = row.coldkey ?? null;
    const sent = from === ss58 && to === counterparty;
    const received = from === counterparty && to === ss58;
    if (!sent && !received) continue;

    const amount = nullableNumber(row.amount_tao);
    if (amount == null) continue;
    if (sent) totalSent += amount;
    if (received) totalReceived += amount;

    const block = nullableInteger(row.block_number);
    if (block != null) {
      firstBlock = firstBlock == null ? block : Math.min(firstBlock, block);
      lastBlock = lastBlock == null ? block : Math.max(lastBlock, block);
    }
    const observed = nullableTimestamp(row.observed_at);
    if (observed != null) {
      firstObserved =
        firstObserved == null ? observed : Math.min(firstObserved, observed);
      lastObserved =
        lastObserved == null ? observed : Math.max(lastObserved, observed);
    }

    transfers.push({
      block_number: block,
      event_index: nullableInteger(row.event_index),
      netuid: nullableInteger(row.netuid),
      from,
      to,
      amount_tao: amount,
      direction: sent ? "sent" : "received",
      observed_at: toIso(observed),
    });
  }

  const cap = Math.max(1, Math.min(limit, 100));
  const scanCapped = list.length >= COUNTERPARTY_RELATIONSHIP_SCAN_CAP;
  return {
    schema_version: 1,
    ss58,
    counterparty,
    transfer_count: transfers.length,
    transfers_scanned: list.length,
    scan_capped: scanCapped,
    total_sent_tao: round(totalSent),
    total_received_tao: round(totalReceived),
    net_tao: round(totalReceived - totalSent),
    // Oldest block/timestamp are unknowable when the newest-first scan was truncated.
    first_block: scanCapped ? null : firstBlock,
    last_block: lastBlock,
    first_seen_at: scanCapped ? null : toIso(firstObserved),
    last_seen_at: toIso(lastObserved),
    limit: cap,
    transfers: transfers.slice(0, cap),
  };
}

// ---- Shared D1 loaders (REST + MCP parity) --------------------------------
// The Worker's account-counterparties handler and the get_account_counterparties
// MCP tool both read the same account_events Transfer tier; these loaders own the
// bounded newest-first scan plus the pure builders so the SQL + envelope shape
// live in exactly one place (mirrors loadChainSigners for the chain tools).
// `d1` is a (sql, params) => rows runner — d1Runner(env) in the Worker,
// mcpD1Runner(ctx) in the MCP server.

// Top counterparties for one account by transfer volume. Bounded newest-first
// scan over the hotkey/coldkey Transfer union (two indexed side seeks, never a
// hotkey/coldkey OR); buildCounterparties does the per-party rollup. Null-safe.
export async function loadCounterparties(d1, ss58, { limit } = {}) {
  const rows = await d1(
    `SELECT ${COUNTERPARTIES_READ_COLUMNS} FROM (SELECT ${COUNTERPARTIES_SCAN_COLUMNS} FROM account_events INDEXED BY idx_account_events_hotkey WHERE event_kind = 'Transfer' AND hotkey = ? UNION ALL SELECT ${COUNTERPARTIES_SCAN_COLUMNS} FROM account_events INDEXED BY idx_account_events_coldkey WHERE event_kind = 'Transfer' AND coldkey = ? AND hotkey <> ?) ORDER BY block_number DESC, event_index DESC LIMIT ?`,
    [ss58, ss58, ss58, COUNTERPARTIES_SCAN_CAP],
  );
  return buildCounterparties(rows, ss58, { limit });
}

// Drill into ONE account/counterparty relationship: the focused fund-flow
// summary plus the bounded transfer evidence. Returns the SAME envelope shape as
// loadCounterparties — a single-element `counterparties` row — with the per-pair
// detail nested under `relationship`, so REST and MCP return one consistent
// object. Callers validate `counterparty` (SS58, differs from ss58) first.
export async function loadCounterpartyRelationship(
  d1,
  ss58,
  counterparty,
  { limit } = {},
) {
  const rows = await d1(
    `SELECT ${COUNTERPARTY_RELATIONSHIP_READ_COLUMNS} FROM (SELECT ${COUNTERPARTY_RELATIONSHIP_READ_COLUMNS} FROM account_events WHERE event_kind = 'Transfer' AND hotkey = ? AND coldkey = ? UNION ALL SELECT ${COUNTERPARTY_RELATIONSHIP_READ_COLUMNS} FROM account_events WHERE event_kind = 'Transfer' AND hotkey = ? AND coldkey = ?) ORDER BY block_number DESC, event_index DESC LIMIT ?`,
    [
      ss58,
      counterparty,
      counterparty,
      ss58,
      COUNTERPARTY_RELATIONSHIP_SCAN_CAP,
    ],
  );
  const relationship = buildCounterpartyRelationship(rows, ss58, counterparty, {
    limit,
  });
  const counterparties =
    relationship.transfer_count === 0
      ? []
      : [
          {
            address: counterparty,
            sent_tao: relationship.total_sent_tao,
            received_tao: relationship.total_received_tao,
            net_tao: relationship.net_tao,
            transfer_count: relationship.transfer_count,
            last_block: relationship.last_block,
          },
        ];
  return {
    schema_version: 1,
    ss58,
    counterparty_count: counterparties.length,
    transfers_scanned: relationship.transfers_scanned,
    scan_capped: relationship.scan_capped,
    total_sent_tao: relationship.total_sent_tao,
    total_received_tao: relationship.total_received_tao,
    counterparties,
    relationship,
  };
}
