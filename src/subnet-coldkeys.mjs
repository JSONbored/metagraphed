// Per-subnet coldkey ownership leaderboard: who actually controls a subnet. Rolls the subnet's
// neurons up by their controlling coldkey — each coldkey's UID count, validator/miner split,
// total stake and emission, and its share of the subnet's stake — ranked by stake, plus an
// ownership-concentration scorecard (Gini/HHI/Nakamoto over the per-coldkey stakes) that shows
// how few entities control the subnet. Distinct from /concentration, which reports the
// coldkey-collapsed concentration METRICS but never names the controlling coldkeys or their
// holdings; this is the entity-level "who owns it" drill-in. Pure shaping (buildSubnetColdkeys)
// + a thin D1 loader (loadSubnetColdkeys); the Worker adds the envelope. Null-safe: a cold store
// or an empty subnet yields a schema-stable empty card.

import { computeConcentration } from "./concentration.mjs";

// The neurons-tier columns the ownership rollup reads for one subnet.
export const SUBNET_COLDKEYS_READ_COLUMNS =
  "coldkey, stake_tao, emission_tao, validator_permit, captured_at, block_number";

// Leaderboard cap — the top-N coldkeys by stake. Bounds the response; a subnet has at most a
// few hundred UIDs, so the controlling-coldkey set is naturally small.
export const SUBNET_COLDKEYS_LIMIT = 50;

// 1 TAO = 1e9 rao; round tao outputs to that precision.
const SCALE = 1e9;
function round9(value) {
  return Math.round(value * SCALE) / SCALE;
}

// Round a 0..1 share to a stable 6dp. Only ever called with a finite ratio (the caller
// guards subnetStake > 0), so no null branch is needed here.
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

// Shape one subnet's neuron rows into the coldkey ownership leaderboard. Neurons with a null/
// blank coldkey stay in the subnet totals (so shares are of the real subnet stake) but form no
// entity. Null-safe on junk/sparse rows — an empty array yields a schema-stable empty card.
export function buildSubnetColdkeys(rows, netuid) {
  const list = Array.isArray(rows) ? rows : [];
  const byColdkey = new Map();
  let subnetStake = 0;
  let subnetEmission = 0;
  let capturedAt = null;
  let latestBlock = null;
  for (const row of list) {
    const stake = toNumber(row?.stake_tao);
    const emission = toNumber(row?.emission_tao);
    subnetStake += stake;
    subnetEmission += emission;
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
        uid_count: 0,
        validator_count: 0,
        miner_count: 0,
        total_stake_tao: 0,
        total_emission_tao: 0,
      };
      byColdkey.set(coldkey, entry);
    }
    entry.uid_count += 1;
    if (Number(row?.validator_permit) === 1) entry.validator_count += 1;
    else entry.miner_count += 1;
    entry.total_stake_tao += stake;
    entry.total_emission_tao += emission;
  }
  const coldkeys = [...byColdkey.values()].map((entry) => ({
    coldkey: entry.coldkey,
    uid_count: entry.uid_count,
    validator_count: entry.validator_count,
    miner_count: entry.miner_count,
    total_stake_tao: round9(entry.total_stake_tao),
    total_emission_tao: round9(entry.total_emission_tao),
    // Share of the subnet's total stake this coldkey controls (null when the subnet has none).
    stake_share:
      subnetStake > 0 ? roundShare(entry.total_stake_tao / subnetStake) : null,
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
    netuid,
    captured_at: capturedAt?.value ?? null,
    block_number: latestBlock,
    neuron_count: list.length,
    coldkey_count: byColdkey.size,
    total_stake_tao: round9(subnetStake),
    total_emission_tao: round9(subnetEmission),
    // How concentrated ownership is across coldkeys (Gini/HHI/Nakamoto over their stakes).
    ownership_concentration: computeConcentration(
      [...byColdkey.values()].map((e) => e.total_stake_tao),
    ),
    coldkeys: coldkeys.slice(0, SUBNET_COLDKEYS_LIMIT),
  };
}

// Shared D1 loader (REST + MCP parity): read this subnet's neuron rows and shape the ownership
// leaderboard. Cold/absent -> empty card. A subnet is capped at a few hundred UIDs, so the read
// is bounded without a LIMIT.
export async function loadSubnetColdkeys(d1, netuid) {
  const rows = await d1(
    `SELECT ${SUBNET_COLDKEYS_READ_COLUMNS} FROM neurons WHERE netuid = ?`,
    [netuid],
  );
  return buildSubnetColdkeys(rows, netuid);
}
