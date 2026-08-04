// Cross-subnet daily history for one validator hotkey (#4334/7.3): staked-
// over-time + a rewards-per-1000-TAO rate, rolled up from the neuron_daily
// tier the same way buildSubnetHistory rolls up a subnet's daily totals
// (src/neuron-history.ts) — one point per snapshot_date, SUM(stake_tao)/
// SUM(emission_tao) across every subnet the hotkey validates in that day
// (idx_neuron_daily_hotkey_date already indexes exactly this access path).

type Row = Record<string, unknown>;

function toFiniteOrNull(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toNonNegativeInt(v: unknown): number | null {
  const n = toFiniteOrNull(v);
  return n != null && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function roundTao(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

// Round a TAO sum, preserving null -- mirrors neuron-history.ts's
// roundTaoOrNull so an unrounded D1 SUM() never leaks float noise while a
// null/cold-day SUM stays null rather than collapsing to 0.
function roundTaoOrNull(v: unknown): number | null {
  const n = toFiniteOrNull(v);
  return n == null ? null : roundTao(n);
}

// emission / stake scaled to a per-1000-TAO reward rate for that day -- null
// when stake is zero/absent (the rate is undefined with nothing staked),
// mirroring the yield-metric null convention in src/subnet-yield.ts.
function rewardsPer1000Tao(
  stakeTao: number | null,
  emissionTao: number | null,
): number | null {
  if (!(stakeTao != null && stakeTao > 0) || emissionTao == null) return null;
  return Math.round((emissionTao / stakeTao) * 1000 * 1e6) / 1e6;
}

// Points arrive newest-first (the handler queries `ORDER BY snapshot_date
// DESC LIMIT MAX_HISTORY_POINTS`), one point per snapshot_date. Null-safe:
// no rows (cold store / empty window) yields a zeroed, empty-point card,
// matching the sibling history routes.
/** A rate/score column: kept as a plain finite number, or null when absent. */
function toRateOrNull(v: unknown): number | null {
  const n = toFiniteOrNull(v);
  return n == null ? null : Math.round(n * 1e6) / 1e6;
}

/**
 * The per-subnet fields, added only when the series is scoped to one netuid.
 *
 * vTrust, consensus, dividends and take are per-(hotkey, netuid) facts. Summing or
 * averaging them across subnets would produce a number the chain never computes --
 * a validator with 1.0 vTrust on one subnet and 0.2 on another does not have "0.6
 * vTrust", it has a problem on the second subnet, which is exactly the signal an
 * average would erase. So the unscoped series deliberately omits them rather than
 * inventing a cross-subnet reading (#9383).
 */
function subnetScopedFields(r: Row): Row {
  const stakeAlpha = roundTaoOrNull(r.stake_alpha);
  const emissionAlpha = roundTaoOrNull(r.emission_alpha);
  return {
    netuid: toNonNegativeInt(r.netuid),
    uid: toNonNegativeInt(r.uid),
    // Native alpha, NOT converted. For every subnet but root this is the unit the
    // chain actually emits in, and it is what an operator compares day over day.
    // Named `_alpha` because #8945 is the standing reminder of what happens when an
    // alpha value is carried in a `*_tao` field.
    stake_alpha: stakeAlpha,
    emission_alpha: emissionAlpha,
    validator_trust: toRateOrNull(r.validator_trust),
    consensus: toRateOrNull(r.consensus),
    dividends: toRateOrNull(r.dividends),
    take: toRateOrNull(r.take),
    // Recorded rather than filtered. A day the permit was lost is a real event an
    // operator needs to see; dropping the row would make it indistinguishable from
    // a day the poller missed.
    validator_permit: r.validator_permit == null ? null : !!r.validator_permit,
    rewards_per_1000_alpha: rewardsPer1000Tao(stakeAlpha, emissionAlpha),
  };
}

export function buildValidatorHistory(
  rows: Row[] | null | undefined,
  hotkey: unknown,
  { window, netuid }: { window?: unknown; netuid?: number | null } = {},
): Row {
  const scoped = netuid != null;
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
        ...(scoped ? subnetScopedFields(r) : {}),
      };
    });
  return {
    schema_version: 1,
    hotkey,
    // Null rather than absent when unscoped, so the field's presence never has to
    // be probed to know which shape the points carry.
    netuid: scoped ? netuid : null,
    window: window ?? null,
    point_count: points.length,
    points,
  };
}
