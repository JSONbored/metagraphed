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
/**
 * Take is a u16 fraction of 0xFFFF on chain, and MUST be compared as one.
 *
 * The stored float is a rendering of that integer, and the rendering is not stable.
 * Measured on a real series (`5G9hfkx9…`, netuid 4) whose take never changed:
 *
 *     2026-07-17..19   0.009994659
 *     2026-07-20..02   0.00999466
 *     2026-08-03       0.009994659342336155
 *
 * All three are u16 655. Comparing the floats reports three take changes that did not
 * happen — and this feature exists to inform a decision the chain then locks for 30
 * days, so a phantom change is worse than no answer. An epsilon would not fix it
 * either: the right tolerance is exactly one u16 step, which is what rounding gives.
 */
export const TAKE_DENOMINATOR = 0xffff;

export function takeToU16(value: unknown): number | null {
  const n = toFiniteOrNull(value);
  if (n === null || n < 0 || n > 1) return null;
  return Math.round(n * TAKE_DENOMINATOR);
}

/**
 * Blocks between permitted delegate-take changes.
 *
 * Read from the chain's own runtime metadata rather than assumed: the
 * `SubtensorModule.TxDelegateTakeRateLimit` storage item is UNSET on mainnet, so the
 * runtime falls back to its declared default, which decodes to 216,000 — exactly 30.00
 * days at 12s blocks. (An unset storage item means the default, never zero.)
 */
export const TAKE_CHANGE_RATE_LIMIT_BLOCKS = 216_000;

interface TakeChangeView {
  take_u16: number | null;
  take_last_changed_date: string | null;
  next_take_change_eligible_date: string | null;
  take_change_observable: boolean;
}

/**
 * When this hotkey's take last changed, within the retained window.
 *
 * `points` arrive NEWEST FIRST. Two things make this deliberately conservative:
 *
 *  1. A leading run of null/0 take is NOT a take of zero. The same real series begins
 *     `null,null,null,null,0,0,0` before its steady value — the column simply was not
 *     being captured yet. Reporting the step out of that run as a take change would
 *     manufacture one for every validator alive when capture started.
 *  2. The retained window (~26 days) is SHORTER than the 30-day rate limit, so "no
 *     change seen" cannot be resolved to "eligible now". It reports unknown.
 *
 * `take_change_observable` says which of those two situations produced a null, so a
 * caller never has to guess whether the absence is "stable" or "we cannot tell".
 */
function takeChangeView(points: Row[]): TakeChangeView {
  const series = points
    .map((p) => ({
      date: typeof p.snapshot_date === "string" ? p.snapshot_date : null,
      u16: takeToU16(p.take),
    }))
    .filter((x) => x.date !== null);

  const newestU16 = series.find((x) => x.u16 !== null)?.u16 ?? null;

  // Oldest-first, with the un-capturable prefix dropped: leading nulls, and the run of
  // zeroes that directly precedes the first nonzero reading (see (1) above).
  const chrono = [...series].reverse();
  let start = 0;
  while (start < chrono.length && chrono[start].u16 === null) start += 1;
  let firstNonZero = start;
  while (firstNonZero < chrono.length && chrono[firstNonZero].u16 === 0)
    firstNonZero += 1;
  // Only treat the zero-run as unusable when a nonzero value follows it. A validator
  // whose take is genuinely 0 throughout keeps its whole series.
  if (firstNonZero < chrono.length) start = firstNonZero;

  const usable = chrono.slice(start).filter((x) => x.u16 !== null);
  let changedDate: string | null = null;
  for (let i = 1; i < usable.length; i += 1) {
    if (usable[i].u16 !== usable[i - 1].u16) changedDate = usable[i].date;
  }

  const eligible =
    changedDate === null
      ? null
      : new Date(
          Date.parse(`${changedDate}T00:00:00Z`) +
            TAKE_CHANGE_RATE_LIMIT_BLOCKS * 12 * 1000,
        )
          .toISOString()
          .slice(0, 10);

  return {
    take_u16: newestU16,
    take_last_changed_date: changedDate,
    next_take_change_eligible_date: eligible,
    // A change was actually resolvable; a false with a null date means the window
    // simply does not reach far enough back to say.
    take_change_observable: changedDate !== null || usable.length >= 2,
  };
}

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
    ...stakeShareView(
      stakeAlpha,
      r.subnet_total_stake,
      toRateOrNull(r.dividends),
    ),
  };
}

interface StakeShareView {
  stake_share: number | null;
  dividend_efficiency: number | null;
}

/**
 * This validator's share of the subnet's stake, and how its dividends compare to it.
 *
 * `dividends` is already normalised by the chain — the column sums to ~1.0 across a
 * subnet's neurons on any given day (measured: 0.99989 on netuid 64) — so it IS the
 * dividend share and needs no denominator of its own. Efficiency is therefore simply
 * dividend share over stake share: above 1 the validator out-earns its stake, below 1
 * it under-earns, and that is the number that says which subnet to leave.
 *
 * THE DENOMINATOR IS TOTAL SUBNET STAKE, including miners, because that is what
 * `subnet_snapshots.total_stake_tao` measures and it rides on a join this query already
 * does. Dividends actually accrue to validators, so the strictly correct denominator is
 * validator stake — measured across netuids 1/4/8/64 that is 99.87–100% of total, i.e.
 * a sub-0.2% difference, the same order as the snapshot total's own drift from the
 * summed neuron rows (0.05–0.21%). Naming it `stake_share` rather than
 * `validator_stake_share` keeps the field honest about which denominator it used.
 *
 * Both sides are the same unit (alpha for non-root subnets), so the ratio is unit-free.
 */
function stakeShareView(
  stakeAlpha: number | null,
  subnetTotal: unknown,
  dividends: number | null,
): StakeShareView {
  const total = toFiniteOrNull(subnetTotal);
  if (stakeAlpha === null || total === null || total <= 0) {
    return { stake_share: null, dividend_efficiency: null };
  }
  const share = stakeAlpha / total;
  const rounded = Math.round(share * 1e6) / 1e6;
  return {
    stake_share: rounded,
    // Undefined with no stake: a validator holding nothing has no share to out-earn.
    dividend_efficiency:
      dividends === null || share <= 0
        ? null
        : Math.round((dividends / share) * 1e6) / 1e6,
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
    // #9390: take is a delegate-level fact, so it is reported once for the series
    // rather than per point. Only the scoped series carries `take` at all.
    ...(scoped
      ? takeChangeView(points as Row[])
      : {
          take_u16: null,
          take_last_changed_date: null,
          next_take_change_eligible_date: null,
          take_change_observable: false,
        }),
    point_count: points.length,
    points,
  };
}
