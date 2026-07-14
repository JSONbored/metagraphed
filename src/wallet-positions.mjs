// Connected-wallet positions (#5243): merges hotkey-owned portfolio rows with
// delegated nominator holdings (#5233), enriched with spot mark and a
// simulated exit value (constant-product unstake quote when pool reserves are
// known; otherwise a 5% slippage band on alpha subnets per ADR 0018 — root
// netuid 0 is exempt). Pure shaping; the Worker adds the REST envelope.

import { computeStakeQuote } from "./stake-quote.mjs";

export const DEFAULT_EXIT_SLIPPAGE = 0.05;

const RAO_PER_TAO = 1e9;
function roundTao(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * RAO_PER_TAO) / RAO_PER_TAO;
}

function nullablePositive(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function orZeroTao(value) {
  return value == null ? 0 : value;
}

function spotMarkTao(netuid, stakeTao, alphaAmount, alphaPrice) {
  if (netuid === 0) return roundTao(stakeTao);
  if (alphaAmount != null && alphaPrice != null && alphaPrice > 0) {
    return roundTao(alphaAmount * alphaPrice);
  }
  return roundTao(stakeTao);
}

function exitValueTao(netuid, stakeTao, alphaAmount, economics) {
  if (netuid === 0) return roundTao(stakeTao);

  const taoIn = nullablePositive(economics?.tao_in_pool_tao);
  const alphaIn = nullablePositive(economics?.alpha_in_pool);
  const alpha = alphaAmount ?? stakeTao;

  if (taoIn != null && alphaIn != null && alpha > 0) {
    const quote = computeStakeQuote({
      netuid,
      taoInPool: taoIn,
      alphaInPool: alphaIn,
      amount: alpha,
      direction: "unstake",
    });
    if (quote.ok) return roundTao(quote.quote.expected_out);
  }

  return roundTao(stakeTao * (1 - DEFAULT_EXIT_SLIPPAGE));
}

function enrichPosition(base, economicsByNetuid) {
  const econ =
    economicsByNetuid?.get?.(base.netuid) ?? economicsByNetuid?.[base.netuid];
  const alphaPrice = nullablePositive(econ?.alpha_price_tao);
  const isRoot = base.netuid === 0;
  const stakeTao = base.stake_tao;
  const alphaAmount =
    !isRoot && alphaPrice != null ? roundTao(stakeTao / alphaPrice) : null;

  const spot_mark_tao = spotMarkTao(
    base.netuid,
    stakeTao,
    alphaAmount,
    alphaPrice,
  );
  const exit_value_tao = exitValueTao(
    base.netuid,
    stakeTao,
    alphaAmount,
    econ ?? null,
  );

  return {
    ...base,
    alpha_amount: alphaAmount,
    alpha_price_tao: alphaPrice,
    root_stake_tao: isRoot ? (roundTao(stakeTao) ?? 0) : 0,
    alpha_stake_tao: isRoot ? 0 : (roundTao(stakeTao) ?? 0),
    spot_mark_tao,
    exit_value_tao,
    realized_yield_tao: null,
  };
}

/**
 * @param {object} opts
 * @param {{ positions?: object[] }} [opts.portfolio] buildAccountPortfolio output
 * @param {{ positions?: object[] }} [opts.nominator] buildAccountPositions (#5233) output
 * @param {Map<number, object>|Record<number, object>} [opts.economicsByNetuid]
 * @param {string} ss58
 */
export function buildWalletPositions(
  { portfolio = {}, nominator = {}, economicsByNetuid = new Map() } = {},
  ss58,
) {
  const econMap =
    economicsByNetuid instanceof Map
      ? economicsByNetuid
      : new Map(
          Object.entries(economicsByNetuid ?? {}).map(([k, v]) => [
            Number(k),
            v,
          ]),
        );

  const positions = [];

  for (const row of Array.isArray(portfolio.positions)
    ? portfolio.positions
    : []) {
    if (!(row?.stake_tao > 0) || row?.netuid == null) continue;
    const kind = row.role === "validator" ? "validator-own" : "miner-own";
    positions.push(
      enrichPosition(
        {
          position_kind: kind,
          netuid: row.netuid,
          hotkey: ss58,
          delegated_hotkey: null,
          uid: row.uid ?? null,
          role: row.role ?? "miner",
          active: Boolean(row.active),
          stake_tao: row.stake_tao,
          share_fraction: null,
        },
        econMap,
      ),
    );
  }

  for (const row of Array.isArray(nominator.positions)
    ? nominator.positions
    : []) {
    if (!(row?.stake_tao > 0) || row?.netuid == null || !row?.hotkey) continue;
    positions.push(
      enrichPosition(
        {
          position_kind: "nominator",
          netuid: row.netuid,
          hotkey: null,
          delegated_hotkey: row.hotkey,
          uid: null,
          role: "nominator",
          active: true,
          stake_tao: row.stake_tao,
          share_fraction: row.share_fraction ?? null,
        },
        econMap,
      ),
    );
  }

  positions.sort((a, b) => {
    const aMark = a.spot_mark_tao ?? a.stake_tao;
    const bMark = b.spot_mark_tao ?? b.stake_tao;
    const byMark = bMark - aMark;
    if (byMark !== 0) return byMark;
    return a.netuid - b.netuid;
  });

  const total_spot_mark_tao = orZeroTao(
    roundTao(positions.reduce((sum, p) => sum + (p.spot_mark_tao ?? 0), 0)),
  );
  const total_exit_value_tao = orZeroTao(
    roundTao(positions.reduce((sum, p) => sum + (p.exit_value_tao ?? 0), 0)),
  );
  const total_stake_tao = orZeroTao(
    roundTao(positions.reduce((sum, p) => sum + p.stake_tao, 0)),
  );

  const captured_at = portfolio.captured_at ?? nominator.captured_at ?? null;

  return {
    schema_version: 1,
    ss58,
    captured_at,
    position_count: positions.length,
    total_stake_tao,
    total_spot_mark_tao,
    total_exit_value_tao,
    positions,
  };
}

/** economics rows -> netuid -> { alpha_price_tao, tao_in_pool_tao, alpha_in_pool } */
export function economicsByNetuidFromRows(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const netuid = Number(row?.netuid);
    if (!Number.isInteger(netuid) || netuid < 0) continue;
    map.set(netuid, {
      alpha_price_tao: nullablePositive(row.alpha_price_tao),
      tao_in_pool_tao: nullablePositive(row.tao_in_pool_tao),
      alpha_in_pool: nullablePositive(row.alpha_in_pool),
    });
  }
  return map;
}
