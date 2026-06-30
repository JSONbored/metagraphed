// Chain analytics builders (#1987, epic #1986): pure row→API shapers for the
// network-activity aggregates served live from the first-party chain D1 tiers
// (blocks / extrinsics / account_events). Kept pure + exported so the Worker does
// the D1 I/O and these stay unit-testable and schema-stable on a cold store.

// Coerce a D1 aggregate cell (COUNT/SUM can come back as a number, a numeric
// string, or null) to a non-negative integer; anything unparseable → 0 so the
// payload is always schema-stable.
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

// Round a ratio to 4 dp without trailing float noise (0.99186… → 0.9919).
// Sub-perfect ratios that would round up to 1.0 are clamped to 0.9999 so a
// near-perfect day is never reported as a perfect success rate.
function round4(value) {
  const rounded = Math.round(value * 1e4) / 1e4;
  return rounded >= 1 && value < 1 ? 0.9999 : rounded;
}

// Coerce a D1 fee/tip cell (TAO float, numeric string, or null) to a finite
// non-negative number rounded to 9 dp (rao precision), so SUM float noise and
// NULL fees never leak into the payload.
function toTao(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 1e9) / 1e9;
}

// Coerce a block-height cell to a non-negative integer, or null when the value is
// missing, non-finite, or negative — block numbers are never negative on-chain.
function toBlockNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

// Merge the two per-UTC-day aggregations (extrinsics tier + blocks tier) into one
// newest-first daily series. `extrinsicRows` carries extrinsic_count /
// successful_extrinsics / unique_signers; `blockRows` carries block_count /
// event_count. Each row is keyed by a `day` = 'YYYY-MM-DD' string. success_rate
// is successful/total, null when a day recorded zero extrinsics (never NaN).
export function buildChainActivity({
  window,
  observedAt = null,
  extrinsicRows = [],
  blockRows = [],
}) {
  const byDay = new Map();
  const ensure = (day) => {
    let row = byDay.get(day);
    if (!row) {
      row = {
        day,
        block_count: 0,
        extrinsic_count: 0,
        event_count: 0,
        successful_extrinsics: 0,
        unique_signers: 0,
      };
      byDay.set(day, row);
    }
    return row;
  };

  for (const r of Array.isArray(extrinsicRows) ? extrinsicRows : []) {
    if (!r || typeof r.day !== "string") continue;
    const row = ensure(r.day);
    row.extrinsic_count = toCount(r.extrinsic_count);
    row.successful_extrinsics = toCount(r.successful_extrinsics);
    row.unique_signers = toCount(r.unique_signers);
  }
  for (const r of Array.isArray(blockRows) ? blockRows : []) {
    if (!r || typeof r.day !== "string") continue;
    const row = ensure(r.day);
    row.block_count = toCount(r.block_count);
    row.event_count = toCount(r.event_count);
  }

  const days = [...byDay.values()]
    // newest UTC day first; ISO 'YYYY-MM-DD' sorts lexicographically = chronologically.
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .map((row) => ({
      day: row.day,
      block_count: row.block_count,
      extrinsic_count: row.extrinsic_count,
      event_count: row.event_count,
      successful_extrinsics: row.successful_extrinsics,
      // Guard the zero-denominator: a day with no extrinsics has an undefined
      // success rate, reported as null (never 0/0 = NaN, which is not JSON).
      success_rate:
        row.extrinsic_count > 0
          ? round4(row.successful_extrinsics / row.extrinsic_count)
          : null,
      unique_signers: row.unique_signers,
    }));

  return {
    schema_version: 1,
    window,
    observed_at: observedAt,
    day_count: days.length,
    days,
  };
}

// Extrinsic call-mix breakdown (#1989): counts + share of each call_module (or
// call_module/call_function pair) over the window. `total` is the FULL-window
// extrinsic count (computed separately, pre-LIMIT) so shares stay honest even
// when the long tail is clipped by the row limit.
export function buildChainCalls({
  window,
  groupBy = "module",
  observedAt = null,
  total = 0,
  rows = [],
}) {
  const totalExtrinsics = toCount(total);
  const calls = (Array.isArray(rows) ? rows : [])
    .filter(
      (r) =>
        r &&
        typeof r.call_module === "string" &&
        r.call_module.length > 0 &&
        (groupBy !== "module_function" ||
          (typeof r.call_function === "string" && r.call_function.length > 0)),
    )
    .map((r) => {
      const count = toCount(r.count);
      return {
        call_module: r.call_module,
        call_function:
          groupBy === "module_function" && typeof r.call_function === "string"
            ? r.call_function
            : null,
        count,
        share: totalExtrinsics > 0 ? round4(count / totalExtrinsics) : null,
      };
    });
  return {
    schema_version: 1,
    window,
    group_by: groupBy,
    observed_at: observedAt,
    total_extrinsics: totalExtrinsics,
    call_count: calls.length,
    calls,
  };
}

// Windowed most-active-account leaderboard (#1990): signers ranked by extrinsic
// count over the window, with their total fees/tips and newest signed block.
export function buildChainSigners({
  window,
  sort = "tx_count",
  observedAt = null,
  rows = [],
}) {
  const sortBy = sort === "total_fee_tao" ? "total_fee_tao" : "tx_count";
  const signers = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r.signer === "string" && r.signer.length > 0)
    .map((r) => ({
      signer: r.signer,
      tx_count: toCount(r.tx_count),
      total_fee_tao: toTao(r.total_fee_tao),
      total_tip_tao: toTao(r.total_tip_tao),
      last_tx_block: toBlockNumber(r.last_tx_block),
    }));
  return {
    schema_version: 1,
    window,
    sort: sortBy,
    observed_at: observedAt,
    signer_count: signers.length,
    signers,
  };
}

// Fee/tip market analytics (#1988): a per-UTC-day fee series (totals + exact
// builder-computed averages; median is a follow-up) plus a windowed top-fee-payer
// list. avg_*_tao guard the zero-denominator (a day with no extrinsics → null).
export function buildChainFees({
  window,
  observedAt = null,
  dailyRows = [],
  payerRows = [],
}) {
  const daily = (Array.isArray(dailyRows) ? dailyRows : [])
    .filter((r) => r && typeof r.day === "string")
    .map((r) => {
      const extrinsicCount = toCount(r.extrinsic_count);
      const totalFee = toTao(r.total_fee_tao);
      const totalTip = toTao(r.total_tip_tao);
      return {
        day: r.day,
        extrinsic_count: extrinsicCount,
        total_fee_tao: totalFee,
        avg_fee_tao:
          extrinsicCount > 0 ? toTao(totalFee / extrinsicCount) : null,
        total_tip_tao: totalTip,
        avg_tip_tao:
          extrinsicCount > 0 ? toTao(totalTip / extrinsicCount) : null,
      };
    })
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));

  const topFeePayers = (Array.isArray(payerRows) ? payerRows : [])
    .filter((r) => r && typeof r.signer === "string" && r.signer.length > 0)
    .map((r) => ({
      signer: r.signer,
      total_fee_tao: toTao(r.total_fee_tao),
      total_tip_tao: toTao(r.total_tip_tao),
      extrinsic_count: toCount(r.extrinsic_count),
    }));

  return {
    schema_version: 1,
    window,
    observed_at: observedAt,
    day_count: daily.length,
    daily,
    top_fee_payers: topFeePayers,
  };
}
