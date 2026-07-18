// Per-subnet / network-wide idle-stake rollup (#6789, follow-up to #6645's
// design spike -- docs/idle-stake-mechanism.md). Dividends are the ONLY
// stream delegated stake ever receives in dTAO (incentive goes to the
// hotkey owner alone, never split with delegators); dividends are zero for
// a hotkey with no validator permit, or a permitted hotkey whose weight-
// setting output is currently zero either way. Stake sitting on such a
// hotkey is "idle" in the sense TaoSwap's `/idle-stakes/` endpoint implies:
// earning nothing, right now. Pure shaping over the neurons tier's own
// dividends/stake_tao columns -- zero new capture, mirrors src/alpha-
// volume.mjs's own "already-captured rows, no new polling" convention.

// 1 TAO = 1e9 rao. Sum in rao-integer BigInt space, not float space --
// summing potentially thousands of neurons' stake_tao (network-wide) with
// plain `+=` compounds rounding error across the accumulation even when
// each individual value is itself exact (mirrors src/concentration.mjs's
// own toRaoBig/raoBigToTao, a deliberate byte-for-byte copy per this
// codebase's per-module rounding-helper convention).
function toRaoBig(taoValue) {
  const n = Number(taoValue);
  return Number.isFinite(n) ? BigInt(Math.round(n * 1e9)) : 0n;
}
function raoBigToTao(rao) {
  return Number(rao / 1_000_000_000n) + Number(rao % 1_000_000_000n) / 1e9;
}

// The rows share one cron capture, but don't assume an order -- take the
// newest captured_at (mirrors src/concentration.mjs's own captureStamp/
// epochMsStamp, a deliberate byte-for-byte copy per this codebase's
// per-module convention). Accepts an epoch-ms number, a numeric-string
// epoch (D1/Postgres often hand back a BIGINT column as a string), or an
// ISO string; anything else (or a non-positive/non-finite epoch) is not a
// real timestamp and is ignored.
function epochMsStamp(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  return { ms, value: date.toISOString() };
}
function captureStamp(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) return epochMsStamp(Number(value));
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? { ms, value } : null;
  }
  if (typeof value === "number") return epochMsStamp(value);
  return null;
}
function newestCapturedAt(rows) {
  let newest = null;
  for (const row of rows) {
    const stamp = captureStamp(row?.captured_at);
    if (stamp && (newest == null || stamp.ms > newest.ms)) newest = stamp;
  }
  return newest?.value ?? null;
}

// A hotkey earning zero dividends right now -- matches TaoSwap's "idle"
// framing (stake sitting on a hotkey that currently pays its delegators
// nothing), regardless of WHY dividends are zero (no permit, or a permit
// with a currently-zero weight-setting output -- both collapse to the same
// observable from a delegator's perspective).
function isIdle(row) {
  // Explicit null/undefined check BEFORE coercion: Number(null) === 0
  // (finite), which would otherwise treat a genuinely-missing/uncaptured
  // dividends value as a real zero (a hotkey earning nothing) rather than
  // "unknown". Postgres NUMERIC columns (dividends included) often arrive
  // as a numeric STRING, not a JS number -- Number("0") === 0 is correct,
  // so the coercion itself is right; only the null/undefined case is wrong.
  if (row?.dividends == null) return false;
  return Number(row.dividends) === 0;
}

// One subnet's idle-stake scorecard. Null-safe: an empty/cold neurons tier
// yields a schema-stable zero (never throws), matching the sibling live
// tiers (concentration, performance).
export function buildSubnetIdleStake(rows, netuid) {
  const list = Array.isArray(rows) ? rows : [];
  let idleStakeRao = 0n;
  let idleNeuronCount = 0;
  for (const row of list) {
    if (!isIdle(row)) continue;
    idleNeuronCount += 1;
    idleStakeRao += toRaoBig(row?.stake_tao);
  }
  return {
    schema_version: 1,
    netuid,
    captured_at: newestCapturedAt(list),
    neuron_count: list.length,
    idle_neuron_count: idleNeuronCount,
    idle_stake_tao: Math.round(raoBigToTao(idleStakeRao) * 1e9) / 1e9,
  };
}

// Network-wide rollup: every subnet's own idle-stake scorecard, ranked by
// idle_stake_tao descending, plus the network total -- mirrors src/chain-
// alpha-volume.mjs's own per-subnet-groupby-then-rollup shape over src/
// alpha-volume.mjs's per-subnet scorecard.
export function buildChainIdleStake(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const bySubnet = new Map();
  for (const row of list) {
    const netuid = Number(row?.netuid);
    if (!Number.isInteger(netuid)) continue;
    let entry = bySubnet.get(netuid);
    if (!entry) {
      entry = { neuronCount: 0, idleNeuronCount: 0, idleStakeRao: 0n };
      bySubnet.set(netuid, entry);
    }
    entry.neuronCount += 1;
    if (isIdle(row)) {
      entry.idleNeuronCount += 1;
      entry.idleStakeRao += toRaoBig(row?.stake_tao);
    }
  }
  let totalIdleStakeRao = 0n;
  const subnets = [...bySubnet.entries()]
    .map(([netuid, entry]) => {
      totalIdleStakeRao += entry.idleStakeRao;
      return {
        netuid,
        neuron_count: entry.neuronCount,
        idle_neuron_count: entry.idleNeuronCount,
        idle_stake_tao: Math.round(raoBigToTao(entry.idleStakeRao) * 1e9) / 1e9,
      };
    })
    .sort((a, b) => b.idle_stake_tao - a.idle_stake_tao || a.netuid - b.netuid);
  return {
    schema_version: 1,
    captured_at: newestCapturedAt(list),
    subnet_count: subnets.length,
    total_idle_stake_tao:
      Math.round(raoBigToTao(totalIdleStakeRao) * 1e9) / 1e9,
    subnets,
  };
}
