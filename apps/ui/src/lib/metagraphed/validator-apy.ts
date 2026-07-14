/**
 * Client-side delegator APY estimates (#5245) until server-side modelling lands
 * in #2551. Uses the same emission÷stake annualization as rewards_per_1000_tao
 * (see src/validator-history.mjs) and applies take when known.
 */

export type ValidatorApyWindow = "7d" | "30d" | "90d" | "snapshot";

/** Gross daily yield as a fraction (emission τ per τ staked per day). */
export function dailyYieldFraction(emissionTao: number, stakeTao: number): number | null {
  if (!(stakeTao > 0) || !Number.isFinite(emissionTao)) return null;
  return emissionTao / stakeTao;
}

/** Delegator net daily yield after validator take (0..1 fraction). */
export function netDailyYield(
  emissionTao: number,
  stakeTao: number,
  take: number | null | undefined,
): number | null {
  const gross = dailyYieldFraction(emissionTao, stakeTao);
  if (gross == null) return null;
  const commission = take != null && Number.isFinite(take) ? Math.min(Math.max(take, 0), 1) : 0;
  return gross * (1 - commission);
}

/** Annualized delegator APY as a percentage. */
export function annualizedDelegatorApyPct(
  emissionTao: number,
  stakeTao: number,
  take?: number | null,
): number | null {
  const daily = netDailyYield(emissionTao, stakeTao, take);
  if (daily == null) return null;
  return Math.round(daily * 365 * 100 * 100) / 100;
}

/** From a history point's rewards_per_1000_tao (τ per 1k τ staked per day). */
export function apyFromRewardsPer1000(
  rewardsPer1000: number | null | undefined,
  take?: number | null,
): number | null {
  if (rewardsPer1000 == null || !Number.isFinite(rewardsPer1000)) return null;
  const commission = take != null && Number.isFinite(take) ? Math.min(Math.max(take, 0), 1) : 0;
  const dailyPerTao = (rewardsPer1000 / 1000) * (1 - commission);
  return Math.round(dailyPerTao * 365 * 100 * 100) / 100;
}

export function formatApyPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 100) return `${value.toFixed(0)}%`;
  if (value >= 10) return `${value.toFixed(1)}%`;
  return `${value.toFixed(2)}%`;
}

export function formatTakePct(take: number | null | undefined): string {
  if (take == null || !Number.isFinite(take)) return "—";
  return `${(take * 100).toFixed(1)}%`;
}
