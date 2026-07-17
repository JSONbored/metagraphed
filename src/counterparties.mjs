// Account counterparty / fund-flow analytics: who one account transacts with,
// aggregated from the account_events Transfer tier (hotkey = from, coldkey = to,
// amount_tao). Pure + exported for unit tests; workers/data-api.mjs does the
// Postgres read + envelope. Null-safe: no transfers → a schema-stable empty
// list (never throws), matching the live account tiers the entity handlers
// already own.

// Bound the transfer scan so a hot wallet can't force an unbounded read. Rows are
// read newest-first; the summary flags when the cap truncated older history.
export const COUNTERPARTIES_SCAN_CAP = 5000;
export const COUNTERPARTY_RELATIONSHIP_SCAN_CAP = 5000;

// Round a TAO sum to rao precision so accumulated float error never leaks a long
// tail into the JSON.
function round(value, dp = 9) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

// Sum in rao-integer BigInt space, not float space -- accumulating TAO amounts
// with plain `+=` compounds rounding error across the scan (up to thousands of
// transfers) even when each individual value is itself exact, so convert each
// addend to integer rao, sum the integers, and convert back once at the end.
// Mirrors the toRaoBig/raoBigToTao pattern established in concentration.mjs /
// chain-yield.mjs (#2933).
function toRaoBig(tao) {
  // Guard the post-multiply value (not just `tao`): a huge-but-finite TAO amount
  // like Number.MAX_VALUE overflows `tao * 1e9` to Infinity, and BigInt(Infinity)
  // throws — so clamp a non-finite rao to 0n, preserving the old round()-based
  // defensive behaviour that dropped an overflowing sum to 0 rather than leaking
  // Infinity/NaN into the JSON.
  const rao = Math.round(tao * 1e9);
  return Number.isFinite(rao) ? BigInt(rao) : 0n;
}

function raoBigToTao(rao) {
  return Number(rao / 1_000_000_000n) + Number(rao % 1_000_000_000n) / 1e9;
}

function nullableNumber(value) {
  if (value == null) return null;
  // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? round(n) : null;
}

function nullableInteger(value) {
  if (value == null) return null;
  // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function nullableTimestamp(value) {
  if (value == null) return null;
  // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? n : null;
}

function toIso(value) {
  const n = nullableTimestamp(value);
  return n == null ? null : new Date(n).toISOString();
}

// Aggregate an account's Transfer rows into per-counterparty fund flow: for each
// transfer the account is one side of, attribute the amount to the OTHER party as
// sent (account = from) or received (account = to). Returns the top-`limit`
// counterparties by total volume (sent + received), each with net flow, count, and
// last block, plus a summary over the full scanned set. Null-safe.
export function buildCounterparties(rows, ss58, { limit = 20 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const byParty = new Map();
  let totalSentRao = 0n;
  let totalReceivedRao = 0n;
  for (const row of list) {
    const from = row?.hotkey;
    const to = row?.coldkey;
    const isSender = from === ss58;
    const isReceiver = to === ss58;
    // The counterparty is the side that ISN'T this account. Skip self-transfers
    // (both sides the account) and rows missing the other side's address.
    let party = null;
    if (isSender && !isReceiver && typeof to === "string" && to.length > 0) {
      party = to;
    } else if (
      isReceiver &&
      !isSender &&
      typeof from === "string" &&
      from.length > 0
    ) {
      party = from;
    }
    if (party == null) continue;
    // Align with buildCounterpartyRelationship: blank/null amount_tao cells must
    // be skipped, not coerced to 0 and counted as a phantom zero-TAO transfer.
    const amount = nullableNumber(row?.amount_tao);
    if (amount == null) continue;
    const sentRao = isSender && !isReceiver ? toRaoBig(amount) : 0n;
    const receivedRao = isReceiver && !isSender ? toRaoBig(amount) : 0n;
    totalSentRao += sentRao;
    totalReceivedRao += receivedRao;
    const entry = byParty.get(party) ?? {
      address: party,
      sentRao: 0n,
      receivedRao: 0n,
      count: 0,
      lastBlock: null,
    };
    entry.sentRao += sentRao;
    entry.receivedRao += receivedRao;
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
      sent_tao: raoBigToTao(entry.sentRao),
      received_tao: raoBigToTao(entry.receivedRao),
      net_tao: raoBigToTao(entry.receivedRao - entry.sentRao),
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
    total_sent_tao: raoBigToTao(totalSentRao),
    total_received_tao: raoBigToTao(totalReceivedRao),
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
  let totalSentRao = 0n;
  let totalReceivedRao = 0n;
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
    if (sent) totalSentRao += toRaoBig(amount);
    if (received) totalReceivedRao += toRaoBig(amount);

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
      observed_at: toIso(row.observed_at),
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
    total_sent_tao: raoBigToTao(totalSentRao),
    total_received_tao: raoBigToTao(totalReceivedRao),
    net_tao: raoBigToTao(totalReceivedRao - totalSentRao),
    // Oldest block/timestamp are unknowable when the newest-first scan was truncated.
    first_block: scanCapped ? null : firstBlock,
    last_block: lastBlock,
    first_seen_at: scanCapped ? null : toIso(firstObserved),
    last_seen_at: toIso(lastObserved),
    limit: cap,
    transfers: transfers.slice(0, cap),
  };
}

// loadCounterparties/loadCounterpartyRelationship (the D1-querying
// account_events readers) were deleted (2026-07-17, D1 fully eliminated) --
// account_events was already dropped from D1 production (#4772), so they had
// zero live callers; every real route (workers/data-api.mjs with real
// Postgres rows, the REST/GraphQL/MCP cold paths with []) calls
// buildCounterparties/buildCounterpartyRelationship directly.
