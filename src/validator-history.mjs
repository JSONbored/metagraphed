// Cross-subnet daily history for one validator hotkey (#4334/7.3): staked-
// over-time + a rewards-per-1000-TAO rate, rolled up from the neuron_daily
// tier the same way buildSubnetHistory rolls up a subnet's daily totals
// (src/neuron-history.mjs) — one point per snapshot_date, SUM(stake_tao)/
// SUM(emission_tao) across every subnet the hotkey validates in that day
// (idx_neuron_daily_hotkey_date already indexes exactly this access path).

function toFiniteOrNull(v) {
  if (v == null) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toNonNegativeInt(v) {
  const n = toFiniteOrNull(v);
  return n != null && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function roundTao(v) {
  return Math.round(v * 1e6) / 1e6;
}

// Round a TAO sum, preserving null -- mirrors neuron-history.mjs's
// roundTaoOrNull so an unrounded D1 SUM() never leaks float noise while a
// null/cold-day SUM stays null rather than collapsing to 0.
function roundTaoOrNull(v) {
  const n = toFiniteOrNull(v);
  return n == null ? null : roundTao(n);
}

// emission / stake scaled to a per-1000-TAO reward rate for that day -- null
// when stake is zero/absent (the rate is undefined with nothing staked),
// mirroring the yield-metric null convention in src/subnet-yield.mjs.
function rewardsPer1000Tao(stakeTao, emissionTao) {
  if (!(stakeTao > 0) || emissionTao == null) return null;
  return Math.round((emissionTao / stakeTao) * 1000 * 1e6) / 1e6;
}

// Points arrive newest-first (the handler queries `ORDER BY snapshot_date
// DESC LIMIT MAX_HISTORY_POINTS`), one point per snapshot_date. Null-safe:
// no rows (cold store / empty window) yields a zeroed, empty-point card,
// matching the sibling history routes.
export function buildValidatorHistory(rows, hotkey, { window } = {}) {
  const points = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r === "object")
    .map((r) => {
      const totalStakeTao = roundTaoOrNull(r.total_stake_tao);
      const totalEmissionTao = roundTaoOrNull(r.total_emission_tao);
      return {
        snapshot_date: r.snapshot_date,
        subnet_count: toNonNegativeInt(r.subnet_count),
        total_stake_tao: totalStakeTao,
        total_emission_tao: totalEmissionTao,
        rewards_per_1000_tao: rewardsPer1000Tao(
          totalStakeTao,
          totalEmissionTao,
        ),
      };
    });
  return {
    schema_version: 1,
    hotkey,
    window: window ?? null,
    point_count: points.length,
    points,
  };
}
