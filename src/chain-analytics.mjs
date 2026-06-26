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
function round4(value) {
  return Math.round(value * 1e4) / 1e4;
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
