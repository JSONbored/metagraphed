// Network-wide coldkey ownership leaderboard: who controls Bittensor across every subnet. Rolls
// EVERY subnet's neurons up by their controlling coldkey — each coldkey's subnet reach, UID count,
// validator/miner split, total stake and emission, and its share of the network's stake — ranked
// by stake, plus a network ownership-concentration scorecard (Gini/HHI/Nakamoto over the per-
// coldkey stakes). The named-entity drill-in of /chain/concentration, which reports the coldkey-
// collapsed concentration METRICS but never names the controlling coldkeys or how many subnets
// each one spans. The network-wide companion to /subnets/{netuid}/coldkeys. Pure shaping
// (buildChainColdkeys) + a thin D1 loader (loadChainColdkeys); the Worker adds the envelope.
// Null-safe: a cold store yields a schema-stable empty card.

import { computeConcentration } from "./concentration.mjs";

// The neurons-tier columns the ownership rollup reads across ALL subnets (like
// CHAIN_CONCENTRATION_READ_COLUMNS but carrying block_number for the stamp).
export const CHAIN_COLDKEYS_READ_COLUMNS =
  "netuid, coldkey, stake_tao, emission_tao, validator_permit, captured_at, block_number";

// Leaderboard cap — the top-N coldkeys by stake. Bounds the response; the controlling-entity set
// is naturally small even network-wide.
export const CHAIN_COLDKEYS_LIMIT = 50;

// 1 TAO = 1e9 rao; round tao outputs to that precision.
const SCALE = 1e9;
function round9(value) {
  return Math.round(value * SCALE) / SCALE;
}

// Round a 0..1 share to a stable 6dp. Only ever called with a finite ratio (the caller guards
// networkStake > 0), so no null branch is needed here.
function roundShare(value) {
  return Math.round(value * 1e6) / 1e6;
}

// Coerce a D1 numeric cell (number, numeric string, or null) to a finite number.
function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Strict non-negative integer coercion: accept ONLY a real number or an all-digits string, so a
// blank/null/false cell is rejected rather than read as 0.
function toInt(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

// A coldkey cell -> non-empty ss58 string, or null when absent/blank (an unattributed neuron).
function toColdkey(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function captureStamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ms: value, value: new Date(value).toISOString() };
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const ms = Number(value);
    return { ms, value: new Date(ms).toISOString() };
  }
  return null;
}

// Shape every subnet's neuron rows into the network-wide coldkey ownership leaderboard. Neurons
// with a null/blank coldkey stay in the network totals (so shares are of the real network stake)
// but form no entity. Null-safe on junk/sparse rows — an empty array yields a schema-stable card.
export function buildChainColdkeys(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byColdkey = new Map();
  const netuids = new Set();
  let networkStake = 0;
  let networkEmission = 0;
  let capturedAt = null;
  let latestBlock = null;
  for (const row of list) {
    const stake = toNumber(row?.stake_tao);
    const emission = toNumber(row?.emission_tao);
    networkStake += stake;
    networkEmission += emission;
    const netuid = toInt(row?.netuid);
    if (netuid != null) netuids.add(netuid);
    const captured = captureStamp(row?.captured_at);
    if (captured && (capturedAt == null || captured.ms > capturedAt.ms)) {
      capturedAt = captured;
    }
    const block = toInt(row?.block_number);
    if (block != null && (latestBlock == null || block > latestBlock)) {
      latestBlock = block;
    }
    const coldkey = toColdkey(row?.coldkey);
    if (coldkey == null) continue;
    let entry = byColdkey.get(coldkey);
    if (!entry) {
      entry = {
        coldkey,
        subnets: new Set(),
        uid_count: 0,
        validator_count: 0,
        miner_count: 0,
        total_stake_tao: 0,
        total_emission_tao: 0,
      };
      byColdkey.set(coldkey, entry);
    }
    if (netuid != null) entry.subnets.add(netuid);
    entry.uid_count += 1;
    if (Number(row?.validator_permit) === 1) entry.validator_count += 1;
    else entry.miner_count += 1;
    entry.total_stake_tao += stake;
    entry.total_emission_tao += emission;
  }
  const coldkeys = [...byColdkey.values()].map((entry) => ({
    coldkey: entry.coldkey,
    // How many subnets this coldkey spans — the network-power signal /concentration lacks.
    subnet_count: entry.subnets.size,
    uid_count: entry.uid_count,
    validator_count: entry.validator_count,
    miner_count: entry.miner_count,
    total_stake_tao: round9(entry.total_stake_tao),
    total_emission_tao: round9(entry.total_emission_tao),
    // Share of the network's total stake this coldkey controls (null when the network has none).
    stake_share:
      networkStake > 0
        ? roundShare(entry.total_stake_tao / networkStake)
        : null,
  }));
  // Biggest owner first; tie-break by UID count then coldkey for a stable order.
  coldkeys.sort(
    (a, b) =>
      b.total_stake_tao - a.total_stake_tao ||
      b.uid_count - a.uid_count ||
      (a.coldkey < b.coldkey ? -1 : 1),
  );
  return {
    schema_version: 1,
    captured_at: capturedAt?.value ?? null,
    block_number: latestBlock,
    subnet_count: netuids.size,
    neuron_count: list.length,
    coldkey_count: byColdkey.size,
    total_stake_tao: round9(networkStake),
    total_emission_tao: round9(networkEmission),
    // How concentrated ownership is across coldkeys network-wide (Gini/HHI/Nakamoto over stakes).
    ownership_concentration: computeConcentration(
      [...byColdkey.values()].map((e) => e.total_stake_tao),
    ),
    coldkeys: coldkeys.slice(0, CHAIN_COLDKEYS_LIMIT),
  };
}

// Shared D1 loader (REST + MCP parity): read every subnet's neuron rows and shape the network-wide
// ownership leaderboard. The full-neurons read mirrors loadChainConcentration. Cold/absent ->
// empty card.
export async function loadChainColdkeys(d1) {
  const rows = await d1(
    `SELECT ${CHAIN_COLDKEYS_READ_COLUMNS} FROM neurons`,
    [],
  );
  return buildChainColdkeys(rows);
}
