// Per-SUBNET alpha-price HISTORY backfill (#1307, epic #1302).
//
// The analogue of src/neuron-history.mjs's neuron_daily backfill, but for the
// per-subnet economics time series that lives in `subnet_snapshots`. The forward
// path (src/health-prober.mjs writeSubnetSnapshot) records `alpha_price_tao` once
// a day going forward; this backfill fills the column RETROACTIVELY off the public
// archive (scripts/backfill-economics-history.py decodes SubnetMovingPrice[netuid]
// → alpha_price_tao = bits / 2**32, matching info.moving_price), so the homepage
// marquee can show real per-subnet alpha-price sparklines NOW instead of waiting
// months for forward accrual.
//
// Pure + injectable for tests — the Worker handler runs the D1 batch and calls
// these. The trajectory endpoint reads subnet_snapshots by (netuid, snapshot_date),
// so a backfilled row MUST land on the same (netuid, day) PK as a forward fire.

const SNAPSHOT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Keep only well-formed backfill rows: integer netuid (≥ 0), a YYYY-MM-DD
// snapshot_date, and a finite numeric alpha_price_tao. Anything else is silently
// dropped so a partial/garbage batch can never poison the table.
export function validEconomicsBackfillRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row) =>
      row &&
      Number.isInteger(row.netuid) &&
      row.netuid >= 0 &&
      typeof row.snapshot_date === "string" &&
      SNAPSHOT_DATE_RE.test(row.snapshot_date) &&
      typeof row.alpha_price_tao === "number" &&
      Number.isFinite(row.alpha_price_tao),
  );
}

// Batched idempotent upsert of HISTORICAL alpha_price_tao into subnet_snapshots.
//
// Each row carries its own snapshot_date (the historical UTC day) + captured_at
// (that block's ms). We INSERT a sparse row keyed on (netuid, snapshot_date) with
// only alpha_price_tao populated (every other economics/structural column NULL),
// and ON CONFLICT set alpha_price_tao = COALESCE(existing, excluded) — IDENTICAL
// to the prober's COALESCE upsert (src/health-prober.mjs writeSubnetSnapshot), so:
//   - a backfilled value can FILL a NULL alpha_price (a day with no forward fire),
//   - it can NEVER clobber a value an earlier forward fire already wrote,
//   - it NEVER touches the structural columns or the other economics columns
//     (completeness/surface/endpoint/validator/miner/stake/emission_share),
//   - captured_at is owned by the first writer of that (netuid, day) row and is
//     only set when this backfill is that first writer.
// The PK (netuid, snapshot_date) makes any re-POST a no-op.
export function economicsSnapshotUpsertStatements(db, rows) {
  const sql =
    `INSERT INTO subnet_snapshots ` +
    `(netuid, snapshot_date, alpha_price_tao, captured_at) ` +
    `VALUES (?, ?, ?, ?) ` +
    `ON CONFLICT (netuid, snapshot_date) DO UPDATE SET ` +
    `alpha_price_tao = COALESCE(subnet_snapshots.alpha_price_tao, excluded.alpha_price_tao)`;
  return rows.map((row) =>
    db
      .prepare(sql)
      .bind(
        row.netuid,
        row.snapshot_date,
        row.alpha_price_tao,
        Number.isFinite(row.captured_at)
          ? row.captured_at
          : Date.parse(`${row.snapshot_date}T00:00:00Z`),
      ),
  );
}
