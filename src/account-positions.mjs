// Connected-wallet positions (#5243 / #5233): hotkey-owned neuron rows plus
// coldkey-delegated (nominator) holdings reconstructed from the all-time
// StakeAdded/StakeRemoved stream, enriched with spot mark and a simulated
// exit value (5% slippage on alpha subnets per ADR 0018; root netuid 0 is
// exempt). Pure shaping + thin loaders; the Worker adds the REST envelope.

import { buildAccountPortfolio } from "./account-portfolio.mjs";

export const STAKE_ADDED_KIND = "StakeAdded";
export const STAKE_REMOVED_KIND = "StakeRemoved";

// Default simulated-exit slippage band (ADR 0018 §3).
export const DEFAULT_EXIT_SLIPPAGE = 0.05;

const SCALE = 1e9;
function round9(value) {
  return Math.round(value * SCALE) / SCALE;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nullableTao(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizedNetuid(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const netuid = Number(value);
  return Number.isSafeInteger(netuid) && netuid >= 0 ? netuid : null;
}

function normalizedHotkey(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullablePrice(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function latestPriceForNetuid(priceByNetuid, netuid) {
  const direct = priceByNetuid?.get?.(netuid);
  if (direct != null) return direct;
  return null;
}

function rootAlphaSplit(netuid, stakeTao) {
  if (netuid === 0) {
    return { root_stake_tao: round9(stakeTao), alpha_stake_tao: 0 };
  }
  return { root_stake_tao: 0, alpha_stake_tao: round9(stakeTao) };
}

function spotMarkTao(netuid, stakeTao, alphaAmount, alphaPrice) {
  if (netuid === 0) return round9(stakeTao);
  if (alphaAmount > 0 && alphaPrice > 0)
    return round9(alphaAmount * alphaPrice);
  return round9(stakeTao);
}

function exitValueTao(netuid, spotMark) {
  if (netuid === 0) return round9(spotMark);
  return round9(spotMark * (1 - DEFAULT_EXIT_SLIPPAGE));
}

function enrichPosition(base, priceByNetuid) {
  const netuid = base.netuid;
  const stakeTao = toNumber(base.stake_tao);
  const alphaAmount = toNumber(base.alpha_amount);
  const alphaPrice = latestPriceForNetuid(priceByNetuid, netuid);
  const spot = spotMarkTao(netuid, stakeTao, alphaAmount, alphaPrice);
  const split = rootAlphaSplit(netuid, stakeTao);
  return {
    ...base,
    ...split,
    alpha_amount: alphaAmount > 0 ? round9(alphaAmount) : null,
    alpha_price_tao: alphaPrice,
    spot_mark_tao: spot,
    exit_value_tao: exitValueTao(netuid, spot),
    realized_yield_tao: null,
  };
}

// Shape nominator rows (GROUP BY netuid, hotkey for one coldkey) into position
// entries. Rows carry net_stake_tao and net_alpha_amount aggregates.
export function buildNominatorPositions(rows) {
  const positions = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const netuid = normalizedNetuid(row?.netuid);
    const hotkey = normalizedHotkey(row?.hotkey);
    if (netuid == null || !hotkey) continue;
    const stakeTao = nullableTao(row?.net_stake_tao);
    const alphaAmount = nullableTao(row?.net_alpha_amount);
    if ((stakeTao ?? 0) <= 0 && (alphaAmount ?? 0) <= 0) continue;
    positions.push({
      position_kind: "nominator",
      netuid,
      hotkey,
      delegated_hotkey: hotkey,
      uid: null,
      role: "nominator",
      active: true,
      stake_tao: round9(stakeTao != null ? stakeTao : alphaAmount),
      alpha_amount: alphaAmount != null ? round9(alphaAmount) : null,
      emission_tao: 0,
      rank: null,
      trust: null,
      incentive: null,
      dividends: null,
      yield: null,
    });
  }
  return positions;
}

// Merge hotkey-owned portfolio positions with coldkey-delegated rows.
export function buildAccountPositions(
  { portfolio, nominatorRows, priceByNetuid },
  ss58,
) {
  const priceMap = priceByNetuid instanceof Map ? priceByNetuid : new Map();
  const hotkeyPositions = (portfolio?.positions ?? []).map((pos) =>
    enrichPosition(
      {
        position_kind: "validator-own",
        netuid: pos.netuid,
        hotkey: ss58,
        delegated_hotkey: null,
        uid: pos.uid,
        role: pos.role,
        active: pos.active,
        stake_tao: pos.stake_tao,
        alpha_amount: null,
        emission_tao: pos.emission_tao,
        rank: pos.rank,
        trust: pos.trust,
        incentive: pos.incentive,
        dividends: pos.dividends,
        yield: pos.yield,
      },
      priceMap,
    ),
  );
  const nominatorPositions = buildNominatorPositions(nominatorRows).map((pos) =>
    enrichPosition(pos, priceMap),
  );
  const positions = [...hotkeyPositions, ...nominatorPositions].sort(
    (a, b) => b.spot_mark_tao - a.spot_mark_tao || a.netuid - b.netuid,
  );
  const totalSpot = round9(
    positions.reduce((sum, p) => sum + toNumber(p.spot_mark_tao), 0),
  );
  const totalExit = round9(
    positions.reduce((sum, p) => sum + toNumber(p.exit_value_tao), 0),
  );
  return {
    schema_version: 1,
    ss58,
    captured_at: portfolio?.captured_at ?? null,
    position_count: positions.length,
    total_spot_mark_tao: totalSpot,
    total_exit_value_tao: totalExit,
    positions,
  };
}

// Latest alpha_price_tao per netuid from subnet_snapshots.
export async function loadLatestAlphaPrices(d1, netuids) {
  const ids = [
    ...new Set((netuids ?? []).filter((n) => Number.isInteger(n) && n >= 0)),
  ];
  const map = new Map();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => "?").join(",");
  const rows = await d1(
    `SELECT netuid, alpha_price_tao FROM subnet_snapshots ` +
      `WHERE netuid IN (${placeholders}) AND alpha_price_tao IS NOT NULL ` +
      `ORDER BY snapshot_date DESC`,
    ids,
  );
  for (const row of Array.isArray(rows) ? rows : []) {
    const netuid = normalizedNetuid(row?.netuid);
    const price = nullablePrice(row?.alpha_price_tao);
    if (netuid == null || price == null || map.has(netuid)) continue;
    map.set(netuid, price);
  }
  return map;
}

export async function loadNominatorPositionRows(d1, coldkey) {
  return d1(
    "SELECT netuid, hotkey, " +
      "COALESCE(SUM(CASE WHEN event_kind = ? THEN amount_tao ELSE 0 END), 0) - " +
      "COALESCE(SUM(CASE WHEN event_kind = ? THEN amount_tao ELSE 0 END), 0) AS net_stake_tao, " +
      "COALESCE(SUM(CASE WHEN event_kind = ? THEN alpha_amount ELSE 0 END), 0) - " +
      "COALESCE(SUM(CASE WHEN event_kind = ? THEN alpha_amount ELSE 0 END), 0) AS net_alpha_amount " +
      "FROM account_events WHERE coldkey = ? AND event_kind IN (?, ?) " +
      "GROUP BY netuid, hotkey " +
      "HAVING net_stake_tao > 0 OR net_alpha_amount > 0",
    [
      STAKE_ADDED_KIND,
      STAKE_REMOVED_KIND,
      STAKE_ADDED_KIND,
      STAKE_REMOVED_KIND,
      coldkey,
      STAKE_ADDED_KIND,
      STAKE_REMOVED_KIND,
    ],
  );
}

export async function loadAccountPositions(d1, ss58) {
  const portfolio = await (async () => {
    const rows = await d1(
      "SELECT netuid, uid, stake_tao, emission_tao, rank, trust, incentive, dividends, validator_permit, active, captured_at " +
        "FROM neurons WHERE hotkey = ? ORDER BY netuid",
      [ss58],
    );
    return buildAccountPortfolio(rows, ss58);
  })();
  const nominatorRows = await loadNominatorPositionRows(d1, ss58);
  const netuids = new Set([
    ...portfolio.positions.map((p) => p.netuid),
    ...nominatorRows
      .map((r) => normalizedNetuid(r?.netuid))
      .filter((n) => n != null),
  ]);
  const priceByNetuid = await loadLatestAlphaPrices(d1, [...netuids]);
  return buildAccountPositions(
    { portfolio, nominatorRows, priceByNetuid },
    ss58,
  );
}
